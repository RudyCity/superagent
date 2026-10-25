/**
 * Phase 4o — read-only, fail-closed recovery production readiness report.
 * No journal write, repair, execution, network notification, or process start.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectMuseRecoveryStorage, verifyMuseRecoveryBackup } from "../remoteAgent/museRecoveryBackup.js";
import { MuseIncidentCenter } from "../remoteAgent/museIncidentCenter.js";
import { describeMuseAlertConfig } from "../remoteAgent/museAlertConfig.js";
import { MuseRecoveryIntegrityEvents } from "../remoteAgent/museRecoveryIntegrityEvents.js";
import { museJournalFile } from "../remoteAgent/museBatchJournal.js";
import { readMuseWatchdogHeartbeat } from "./museWatchdogSupervisor.js";
import { readMuseAlertProbe } from "./museAlertProbe.js";
import { readMuseDrillEvidence } from "./museDrillEvidence.js";

export type ReadinessSeverity = "PASS" | "WARN" | "FAIL";
export type ReadinessCheck = { id: string; severity: ReadinessSeverity; code: string; guidance: string };
export type MuseReadiness = { version: 1; port: number; status: ReadinessSeverity; score: number;
  evaluatedAt: number; checks: ReadinessCheck[]; counts: { pass: number; warn: number; fail: number } };
type HostEvidence = { verified: boolean; mode?: "idle" | "muse-ws" | "telegram-fallback"; status?: string };
export type ReadinessOptions = { port: number; root?: string; backup?: string; now?: number;
  maximumBackupAgeHours?: number; host?: HostEvidence };
export function evaluateMuseReadiness(options: ReadinessOptions): MuseReadiness {
  const { port } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid readiness port");
  const root = options.root || path.join(os.homedir(), ".superagent-r");
  const now = options.now ?? Date.now();
  const maxAge = options.maximumBackupAgeHours ?? 168;
  if (!Number.isSafeInteger(now) || now <= 0 ||
      !Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 2160) {
    throw new Error("Invalid readiness options");
  }
  const checks: ReadinessCheck[] = [];
  const add = (id: string, severity: ReadinessSeverity, code: string, guidance: string) =>
    checks.push({ id, severity, code, guidance });
  const host = options.host;
  if (!host?.verified) add("host", "FAIL", "NO_VERIFIED_OWNER",
    "Start and verify an independent channel-host on this port; do not reuse MCP tunnel ports.");
  else if (host.status === "error") add("host", "FAIL", "HOST_ERROR",
    "Inspect channel-host startup and recover the owner under an operator review.");
  else if (host.mode === "idle" || host.status !== "running") add("host", "WARN", "NOT_OPERATIONAL",
    "An idle/starting channel-host is not a verified active Muse or Telegram watcher.");
  else add("host", "PASS", "OWNER_VERIFIED", "Owner identity and running status verified.");

  try {
    const journal = museJournalFile(port, root);
    const present = fs.existsSync(journal);
    const events = new MuseRecoveryIntegrityEvents(port, root).read();
    if (!present) {
      const other = fs.existsSync(path.join(root, "muse-restore-" + port + ".incomplete")) ||
        fs.existsSync(path.join(root, "muse-results-" + port + ".json")) ||
        fs.existsSync(path.join(root, "muse-execution-" + port + ".json")) || events.length > 0;
      add("recovery", other ? "FAIL" : "WARN",
        other ? "ORPHANED_RECOVERY" : "NEW_OWNER_NO_HISTORY",
        other ? "Investigate orphan recovery artifacts before operations." :
          "No durable batch journal exists yet. Run a safe isolated recovery drill before production.");
    } else {
      const report = inspectMuseRecoveryStorage(port, root);
      if (report.integrityBlocked !== 0) add("recovery", "FAIL", "RECOVERY_BLOCKED",
        "Resolve independently verified checkpoint inconsistencies offline; never auto-replay tools.");
      else add("recovery", "PASS", "RECOVERY_VERIFIED", "Cross-store recovery state validated.");
    }
  } catch {
    add("recovery", "FAIL", "RECOVERY_UNREADABLE",
      "Recovery history or encryption key invalid. Stop side effects; verify offline and restore a validated backup.");
  }

  try {
    const incidents = new MuseIncidentCenter(port, root).summary();
    if (incidents.open || incidents.acknowledged) add("incidents", "WARN", "UNRESOLVED_INCIDENTS",
      "Open or acknowledged incidents require manual review; ACK does not resolve them.");
    else if (incidents.pending > 0) add("incidents", "WARN", "ALERTS_PENDING",
      "Outbound notifications remain pending; verify target and retry eligibility.");
    else add("incidents", "PASS", "INCIDENT_QUEUE_CLEAR", "No outstanding incidents or alerts.");
  } catch {
    add("incidents", "FAIL", "INCIDENT_STORAGE_UNREADABLE",
      "Do not silently reset the incident ledger; inspect local storage and backup.");
  }

  try {
    const cfg = describeMuseAlertConfig(port, root);
    if (!cfg.credentialConfigured) add("alerts", "WARN", "PROVIDER_DISABLED",
      "Configure Telegram or a trusted webhook through channel-host config commands.");
    else add("alerts", "PASS", "PROVIDER_CONFIGURED",
      "Provider configured (not proof of actual external receipt); send an explicitly approved test alert.");
  } catch {
    add("alerts", "FAIL", "ALERT_CONFIG_INVALID",
      "Invalid encrypted provider configuration; notifications are blocked, no unsafe fallback.");
  }

  try {
    const proof = readMuseAlertProbe(port, root, now);
    if (!proof) add("delivery", "WARN", "DELIVERY_NOT_TESTED",
      "Explicitly run alert-test --confirm-send with an approved configured provider.");
    else if (!proof.currentConfig) add("delivery", "WARN", "PROVIDER_CHANGED_SINCE_TEST",
      "Run alert-test again after changing the external alert provider.");
    else if (now - proof.testedAt > 24 * 3_600_000) add("delivery", "WARN", "DELIVERY_TEST_STALE",
      "Repeat explicitly approved alert-test; an old HTTP success is not operational proof.");
    else add("delivery", "PASS", "TEST_HTTP_ACCEPTED",
      "Provider accepted a recent test request; downstream human receipt is not guaranteed.");
  } catch {
    add("delivery", "FAIL", "DELIVERY_PROBE_INVALID",
      "Invalid external test evidence; do not claim external delivery is proven.");
  }

  try {
    const beat = readMuseWatchdogHeartbeat(port, root, now);
    if (!beat) add("watchdog", "WARN", "NO_WATCHDOG_HEARTBEAT",
      "Run watchdog-supervise in an independent managed process to detect host outages.");
    else if (now - beat.observedAt > 90_000) add("watchdog", "FAIL", "WATCHDOG_STALE",
      "Independent watchdog heartbeat is overdue; investigate supervisor ownership.");
    else add("watchdog", "PASS", "WATCHDOG_REPORTING",
      "Recent independent watchdog observation recorded (not proof of OS-level supervisor uptime).");
  } catch {
    add("watchdog", "FAIL", "WATCHDOG_STORAGE_INVALID",
      "Inspect watchdog heartbeat file; unreadable/untrusted data never grants readiness.");
  }

  try {
    const drill = readMuseDrillEvidence(port, root, now);
    if (!drill) add("drill", "WARN", "DR_DRILL_NOT_RECORDED",
      "Run dr-drill --port PORT to exercise isolated crash, anti-replay and restore.");
    else if (now - drill.completedAt > 7 * 24 * 3_600_000) {
      add("drill", "WARN", "DR_DRILL_STALE", "Repeat the isolated DR drill on the updated build.");
    } else add("drill", "PASS", "ISOLATED_DR_DRILL_PASSED",
      "Recent isolated recovery exercise passed; production behavior remains unproven.");
  } catch {
    add("drill", "FAIL", "DR_EVIDENCE_INVALID",
      "Drill evidence corrupted; do not interpret it as a passing test.");
  }

  if (!options.backup) add("backup", "WARN", "BACKUP_NOT_SPECIFIED",
    "Use --backup ABSOLUTE_BUNDLE_PATH to verify integrity and freshness; no backup was assumed.");
  else {
    try {
      if (!path.isAbsolute(options.backup)) throw new Error("Relative backup path");
      verifyMuseRecoveryBackup(options.backup, port);
      const filename = path.join(options.backup, "recovery-bundle.json");
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64_000) throw new Error("Invalid manifest");
      const metadata = JSON.parse(fs.readFileSync(filename, "utf8"));
      const age = now - metadata.createdAt;
      if (!Number.isSafeInteger(metadata.createdAt) || age < 0) {
        add("backup", "FAIL", "BACKUP_CLOCK_INVALID", "Backup timestamp is in the future or invalid.");
      } else if (age > maxAge * 3_600_000) {
        add("backup", "WARN", "BACKUP_STALE", "Take and verify a newer offline snapshot in a protected vault.");
      } else add("backup", "PASS", "BACKUP_VERIFIED",
        "Bundle hash and complete encrypted stores validated; freshness is not rollback-proof.");
    } catch {
      add("backup", "FAIL", "BACKUP_INVALID",
        "Backup missing, mismatched port, unsafe or corrupted; do not attempt automatic restore.");
    }
  }

  const counts = { pass: checks.filter(c => c.severity === "PASS").length,
    warn: checks.filter(c => c.severity === "WARN").length,
    fail: checks.filter(c => c.severity === "FAIL").length };
  const status = counts.fail ? "FAIL" : counts.warn ? "WARN" : "PASS";
  // Each subsystem carries equal weight; warning half-credit. This is an
  // operational indicator, not a certified security measure.
  const score = Math.round(100 * (counts.pass + counts.warn * 0.5) / checks.length);
  return { version: 1, port, status, score, evaluatedAt: now, checks, counts };
}
