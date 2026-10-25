/**
 * P0 disaster-recovery exercise, executed exclusively inside a new OS temp
 * directory with its own test port and durable encryption keys.
 * Starts ONE throwaway child Bun process for an unclean checkpointed exit.
 * No real Muse, Telegram, channel host, MCP, model, or user workspace access.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { MuseBatchJournal } from "../remoteAgent/museBatchJournal.js";
import { MuseExecutionCheckpoint } from "../remoteAgent/museExecutionCheckpoint.js";
import { MuseResultOutbox } from "../remoteAgent/museResultOutbox.js";
import { MuseIncidentCenter } from "../remoteAgent/museIncidentCenter.js";
import { MuseRecoveryIntegrityEvents } from "../remoteAgent/museRecoveryIntegrityEvents.js";
import { storeMuseAlertConfig, loadMuseAlertConfig } from "../remoteAgent/museAlertConfig.js";
import {
  inspectMuseRecoveryStorage, makeMuseRecoveryBackup, restoreMuseRecoveryBackup,
  verifyMuseRecoveryBackup, restoreMarker,
} from "../remoteAgent/museRecoveryBackup.js";
export type MuseDrillResult = { ok: boolean; isolated: true; checks: string[];
  failed: string[]; durationMs: number };
function childModule(relative: string): string {
  const js = fileURLToPath(new URL(relative + ".js", import.meta.url));
  const ts = fileURLToPath(new URL(relative + ".ts", import.meta.url));
  return pathToFileURL(fs.existsSync(js) ? js : ts).href;
}
export async function runMuseDisasterRecoveryDrill(
  port = 51671,
): Promise<MuseDrillResult> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid isolated drill port");
  }
  const begin = Date.now();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-muse-dr-"));
  const original = path.join(temp, "original");
  const restored = path.join(temp, "restored");
  const bundle = path.join(temp, "verified-bundle");
  const tampered = path.join(temp, "tampered-bundle");
  const checks: string[] = [];
  const failed: string[] = [];
  const check = (code: string, pass: boolean) => {
    if (pass) checks.push(code);
    else failed.push(code);
  };
  try {
    fs.mkdirSync(original, { mode: 0o700 });
    const batch = "dr-uncertain-" + crypto.randomBytes(5).toString("hex");
    const task = "dr-task";
    const journalUrl = childModule("../remoteAgent/museBatchJournal");
    const intentUrl = childModule("../remoteAgent/museExecutionCheckpoint");
    const script = [
      "const { MuseBatchJournal } = await import(" + JSON.stringify(journalUrl) + ");",
      "const { MuseExecutionCheckpoint } = await import(" + JSON.stringify(intentUrl) + ");",
      "const root=" + JSON.stringify(original) + ";",
      "const port=" + port + ";",
      "const j=new MuseBatchJournal(port,root);",
      "if(!j.claim(" + JSON.stringify(batch) + "," + JSON.stringify(task) + ",1))process.exit(81);",
      "const e=new MuseExecutionCheckpoint(port,root);",
      "e.store({v:1,kind:'task_batch',id:" + JSON.stringify(batch) +
        ",task_id:" + JSON.stringify(task) +
        ",calls:[{id:'side-effect',tool:'write',args:{content:'SECRET_DR_TOOL_ARG'}}]},root);",
      "e.markStarted(" + JSON.stringify(batch) + ",'side-effect');",
      "try{process.kill(process.pid,'SIGKILL')}catch{}",
      "process.exit(93);",
    ].join("\n");
    const crash = spawnSync(process.execPath, ["-e", script], {
      cwd: temp, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000, maxBuffer: 20_000,
      env: { ...process.env, SUPERAGENT_MUSE_ALERT_WEBHOOK_URL: "",
        SUPERAGENT_MUSE_ALERT_TELEGRAM_BOT_TOKEN: "" },
      windowsHide: true,
    });
    check("throwaway_child_exited_uncleanly", crash.status !== 0 || crash.signal !== null);
    const reloaded = new MuseBatchJournal(port, original);
    const recoveredIntent = new MuseExecutionCheckpoint(port, original);
    check("crashed_batch_reserved_once", reloaded.claim(batch, "ATTACK_REPLAY", 1) === false);
    const state = recoveredIntent.info(batch);
    check("started_tool_call_never_auto_resumable", Boolean(state?.started === 1 &&
      !state.canResumeUntouched && recoveredIntent.reserveUntouched(batch, [original]) === null));
    check("crash_checkpoint_sealed", !fs.readFileSync(path.join(original,
      "muse-execution-" + port + ".json"), "utf8").includes("SECRET_DR_TOOL_ARG"));
    const pending = "dr-pending-" + crypto.randomBytes(4).toString("hex");
    reloaded.claim(pending, "dr-pending-task", 0);
    reloaded.transition(pending, "result_pending");
    const results = new MuseResultOutbox(port, original);
    results.put({ v: 1, kind: "task_result", id: pending,
      task_id: "dr-pending-task", results: [{ id: "dr", ok: true, output: "SECRET_DR_RESULT" }] });
    storeMuseAlertConfig(port, { mode: "disabled" }, original);
    const events = new MuseRecoveryIntegrityEvents(port, original);
    events.append(Date.now() - 5_000, "degraded", "STORAGE_CHECK_FAILED");
    const incidents = new MuseIncidentCenter(port, original);
    incidents.syncIntegrity();
    const unacknowledged = incidents.summary().pending;
    check("prebackup_cross_store_integrity", inspectMuseRecoveryStorage(port, original)
      .integrityBlocked === 0);
    const before = makeMuseRecoveryBackup(port, bundle, original);
    const verified = verifyMuseRecoveryBackup(bundle, port);
    check("verified_full_backup", verified.active === before.active &&
      verified.encryptedIntents === before.encryptedIntents);
    const manifest = fs.readFileSync(path.join(bundle, "recovery-bundle.json"), "utf8");
    check("no_secret_payload_in_backup_manifest", !manifest.includes("SECRET_DR_"));
    fs.cpSync(bundle, tampered, { recursive: true });
    fs.appendFileSync(path.join(tampered, "muse-batches-" + port + ".json"), "CORRUPTED");
    let refusedTamper = false;
    try { verifyMuseRecoveryBackup(tampered, port); } catch { refusedTamper = true; }
    check("tampered_backup_rejected_before_restore", refusedTamper);
    check("never_uses_tampered_source", !fs.existsSync(restoreMarker(port, restored)));
    const after = restoreMuseRecoveryBackup(port, bundle, restored);
    check("restore_integrity", after.active === before.active &&
      !fs.existsSync(restoreMarker(port, restored)));
    const claimed = new MuseBatchJournal(port, restored);
    const exec = new MuseExecutionCheckpoint(port, restored);
    check("restored_started_batch_replay_denied", !claimed.claim(batch, "replay", 1) &&
      exec.reserveUntouched(batch, [restored]) === null);
    check("restored_pending_result_preserved", !claimed.claim(pending, "replay", 0) &&
      new MuseResultOutbox(port, restored).get(pending)?.task_id === "dr-pending-task");
    const observed = new MuseIncidentCenter(port, restored);
    check("restored_incident_queue_no_duplication",
      observed.syncIntegrity() === 0 && observed.summary().pending === unacknowledged);
    check("restored_provider_config_encrypted", loadMuseAlertConfig(port, restored)?.mode === "disabled");
    let blockedRollback = false;
    try { restoreMuseRecoveryBackup(port, bundle, restored); } catch { blockedRollback = true; }
    check("occupied_restore_refused", blockedRollback);
    return { ok: failed.length === 0, isolated: true, checks, failed, durationMs: Date.now() - begin };
  } finally {
    // Remove only our random temporary exercise root.
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
