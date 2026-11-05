/**
 * SuperAgent Global Lifecycle Recycle Orchestrator
 *
 * One coherent migration orchestrator for moving legacy or unverified service owners
 * into the existing supervised lifecycle without turning "recycle" into a dangerous
 * "restart all".
 *
 * Invariants:
 * - NO arbitrary PID kills.
 * - NO public tunnel rotation.
 * - MCP reloadable owner preserved (KEEP).
 * - Optional inactive services stay inactive (SKIP_INACTIVE).
 * - Plan expiration (5 minutes).
 * - Idempotent execution (operation ID is idempotency key).
 * - Fail-closed on identity or build mismatch.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir, getPackageRootDir } from "../config/paths.js";
import {
  MANAGED_SERVICE_NAMES,
  type ManagedServiceName,
} from "./serviceManagerTypes.js";
import { inspectServices, type ServiceStatus } from "./serviceManager.js";
import {
  planLegacyCoreRecycle,
  scheduleLegacyCoreRecycle,
  type LegacyCoreRecyclePlan,
} from "./coreLegacyRecycle.js";
import {
  planLegacyTrayRecycle,
  executeLegacyTrayRecycle,
  type LegacyTrayRecyclePlan,
} from "./trayLegacyRecycle.js";
import {
  planLegacyVisionRecycle,
  executeLegacyVisionRecycle,
  type LegacyVisionRecyclePlan,
} from "./visionLegacyRecycle.js";
import { readLifecycleSettings, dependencyOrder } from "./lifecycleProfiles.js";
import { recordLifecycleEvent, operationHashPrefix } from "./lifecycleTimeline.js";
import { validateCoreOperationId } from "./coreLifecycleLedger.js";
import { readListenerOwners } from "./coreMcpOwnershipAudit.js";

export type RecycleDisposition =
  | "keep"
  | "start"
  | "restart"
  | "reload"
  | "recycle"
  | "verify_only"
  | "skip_inactive"
  | "blocked";

export type GlobalRecycleChildPlan = {
  service: ManagedServiceName;
  disposition: RecycleDisposition;
  reasonCode: string;
  note: string;
  port?: number;
  operationId?: string;
  expectedOwnerPid?: number | null;
  expectedProcessIdentity?: string;
  expectedBuildDigest?: string;
  dependencyState: string[];
  childPlan?: Record<string, unknown>;
};

export type GlobalRecyclePlan = {
  version: 1;
  operationId: string;
  createdAt: number;
  expiresAt: number; // 5-minute bound
  dependencyOrder: ManagedServiceName[];
  children: GlobalRecycleChildPlan[];
  summary: {
    total: number;
    mutations: number;
    noops: number;
    blocked: number;
  };
  publicTunnelMutationAllowed: false;
  arbitraryPidKillAllowed: false;
  note: string;
};

export type GlobalRecycleLedgerEntry = {
  version: 1;
  operationId: string;
  createdAt: number;
  updatedAt: number;
  status:
    | "planned"
    | "precheck"
    | "draining"
    | "migrating"
    | "verifying"
    | "completed"
    | "partial"
    | "blocked"
    | "uncertain"
    | "reconciled";
  completedAt?: number;
  childResults: {
    service: ManagedServiceName;
    disposition: RecycleDisposition;
    changed: boolean;
    replayed: boolean;
    previousPid?: number | null;
    ownerPid?: number | null;
    status: "succeeded" | "skipped" | "blocked" | "failed" | "reconciled";
    errorCode?: string;
    note?: string;
  }[];
  error?: string;
  plan?: GlobalRecyclePlan;
  planDigest?: string;
};

function digestGlobalPlan(plan: GlobalRecyclePlan): string {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

const DEFAULT_DEPENDENCY_ORDER: ManagedServiceName[] = [
  "core",
  "daemon",
  "guardian",
  "transport",
  "channel_host",
  "muse",
  "telegram",
  "vision",
  "tray",
  "mcp",
  "rest_tunnel",
  "muse_tunnel",
  "process_supervisor",
];

export const globalRecycleLedgerPath = () =>
  path.join(getRootConfigDir(), "global-recycle-ledger.json");

export class GlobalRecycleLedger {
  private file = globalRecycleLedgerPath();

  read(): Record<string, GlobalRecycleLedgerEntry> {
    try {
      if (!fs.existsSync(this.file)) return {};
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
        throw new Error('GLOBAL_RECYCLE_LEDGER_UNSAFE');
      }
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('GLOBAL_RECYCLE_LEDGER_INVALID');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  write(entries: Record<string, GlobalRecycleLedgerEntry>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(tmp, this.file);
  }

  lookup(operationId: string): GlobalRecycleLedgerEntry | null {
    validateCoreOperationId(operationId);
    const all = this.read();
    return all[operationId] ?? null;
  }

  getPlan(operationId: string): GlobalRecyclePlan {
    const entry = this.lookup(operationId);
    if (!entry?.plan || !entry.planDigest || entry.planDigest !== digestGlobalPlan(entry.plan)) {
      throw new Error('GLOBAL_RECYCLE_ORIGINAL_PLAN_UNAVAILABLE');
    }
    return entry.plan;
  }

  recordPlan(plan: GlobalRecyclePlan) {
    validateCoreOperationId(plan.operationId);
    const all = this.read();
    if (all[plan.operationId]) throw new Error('GLOBAL_RECYCLE_OPERATION_ALREADY_EXISTS');
    all[plan.operationId] = {
      version: 1,
      plan,
      planDigest: digestGlobalPlan(plan),
      operationId: plan.operationId,
      createdAt: plan.createdAt,
      updatedAt: Date.now(),
      status: "planned",
      childResults: plan.children.map((c) => ({
        service: c.service,
        disposition: c.disposition,
        changed: false,
        replayed: false,
        previousPid: c.expectedOwnerPid ?? null,
        ownerPid: c.expectedOwnerPid ?? null,
        status:
          c.disposition === "blocked"
            ? "blocked"
            : ["keep", "skip_inactive", "verify_only"].includes(c.disposition)
            ? "skipped"
            : "succeeded",
        note: c.note,
      })),
    };
    this.write(all);
  }

  updatePhase(
    operationId: string,
    status: GlobalRecycleLedgerEntry["status"],
    childResult?: GlobalRecycleLedgerEntry["childResults"][number]
  ) {
    const all = this.read();
    const entry = all[operationId];
    if (!entry) return;
    entry.status = status;
    entry.updatedAt = Date.now();
    if (childResult) {
      const idx = entry.childResults.findIndex(
        (r) => r.service === childResult.service
      );
      if (idx >= 0) entry.childResults[idx] = childResult;
      else entry.childResults.push(childResult);
    }
    this.write(all);
  }

  complete(operationId: string) {
    const all = this.read();
    const entry = all[operationId];
    if (!entry) return;
    entry.status = "completed";
    entry.updatedAt = Date.now();
    entry.completedAt = Date.now();
    this.write(all);
  }

  fail(
    operationId: string,
    status: "partial" | "blocked" | "uncertain",
    errorMessage: string
  ) {
    const all = this.read();
    const entry = all[operationId];
    if (!entry) return;
    entry.status = status;
    entry.updatedAt = Date.now();
    entry.error = errorMessage;
    this.write(all);
  }

  reconcile(operationId: string, reviewed: boolean): GlobalRecycleLedgerEntry {
    if (reviewed !== true) {
      throw new Error("GLOBAL_RECYCLE_RECONCILE_REVIEWED_REQUIRED");
    }
    const all = this.read();
    const entry = all[operationId];
    if (!entry) {
      throw new Error("GLOBAL_RECYCLE_OPERATION_NOT_FOUND");
    }
    if (!['uncertain', 'partial', 'blocked'].includes(entry.status)) {
      throw new Error('GLOBAL_RECYCLE_RECONCILE_STATE_NOT_UNCERTAIN');
    }
    if (entry.childResults.some(result => ['start','restart','reload','recycle'].includes(result.disposition))) {
      throw new Error('GLOBAL_RECYCLE_RECONCILE_REQUIRES_CHILD_OWNER_EVIDENCE');
    }
    entry.status = "reconciled";
    entry.updatedAt = Date.now();
    for (const res of entry.childResults) {
      if (res.status === "failed") {
        res.status = "reconciled";
      }
    }
    this.write(all);
    return entry;
  }
}

/**
 * Computes deterministic disposition for each managed service based on current live evidence.
 */
export async function determineServiceDisposition(
  status: ServiceStatus
): Promise<{
  disposition: RecycleDisposition;
  reasonCode: string;
  note: string;
  childPlan?: Record<string, unknown>;
}> {
  const { service, state, ownershipVerified, ownerPid } = status;

  if (service === "core") {
    if (ownershipVerified && state === "active") {
      return {
        disposition: "keep",
        reasonCode: "CORE_SUPERVISED_HEALTHY",
        note: "Core is supervised and healthy; preserve existing owner.",
      };
    }
    if (state === "unverified" && ownerPid) {
      try {
        const plan = await planLegacyCoreRecycle(status.port ?? 7888);
        return {
          disposition: "recycle",
          reasonCode: "CORE_LEGACY_PROVABLE",
          note: "Legacy Core server verified on port; guarded recycle to supervised owner available.",
          childPlan: plan as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          disposition: "blocked",
          reasonCode: "CORE_RECYCLE_PRECHECK_FAILED",
          note:
            "Legacy Core evidence precheck failed: " +
            (err instanceof Error ? err.message : String(err)),
        };
      }
    }
    return {
      disposition: 'blocked',
      reasonCode: 'CORE_START_REQUIRES_SEPARATE_OWNER_PLAN',
      note: 'Core is inactive; use an explicit managed Core start plan rather than treating global recycle as start-all.',
    };
  }

  if (service === "mcp") {
    if (ownershipVerified && status.details?.reloadable === true) {
      return {
        disposition: "keep",
        reasonCode: "MCP_VERIFIED_RELOADABLE_PRESERVED",
        note: "MCP owner is verified and reloadable; keep owner, public URL and OAuth state unchanged.",
      };
    }
    if (ownerPid) {
      return {
        disposition: "blocked",
        reasonCode: "MCP_LEGACY_REAUTHORIZATION_REQUIRED",
        note: "Legacy MCP server running. Never automatically migrate OAuth tokens or rotate tunnels; manual operator re-authorization required.",
      };
    }
    return {
      disposition: "skip_inactive",
      reasonCode: "MCP_INACTIVE",
      note: "MCP service inactive; do not force start.",
    };
  }

  if (service === "vision") {
    if (ownershipVerified && state === "active") {
      return {
        disposition: "keep",
        reasonCode: "VISION_MANAGED_HEALTHY",
        note: "Vision server is managed with token authentication; keep active.",
      };
    }
    if (ownerPid) {
      try {
        const plan = await planLegacyVisionRecycle(status.port ?? 8095);
        if (plan.supportsGracefulShutdown) {
          return {
            disposition: "recycle",
            reasonCode: "VISION_LEGACY_PROVABLE",
            note: "Legacy Vision server responds to local graceful shutdown; guarded recycle available.",
            childPlan: plan as unknown as Record<string, unknown>,
          };
        }
        return {
          disposition: "blocked",
          reasonCode: "VISION_GRACEFUL_STOP_UNAVAILABLE",
          note: "Legacy Vision server running but does not expose graceful shutdown endpoint; operator action required.",
        };
      } catch (err) {
        return {
          disposition: "blocked",
          reasonCode: "VISION_RECYCLE_BLOCKED",
          note:
            "Vision recycle precheck blocked: " +
            (err instanceof Error ? err.message : String(err)),
        };
      }
    }
    return {
      disposition: "skip_inactive",
      reasonCode: "VISION_INACTIVE",
      note: "Vision service inactive; skip.",
    };
  }

  if (service === "tray") {
    if (ownershipVerified && state === "active") {
      return {
        disposition: "keep",
        reasonCode: "TRAY_MANAGED_HEALTHY",
        note: "Tray desktop app is managed and verified; keep running.",
      };
    }
    if (ownerPid || state === "unverified") {
      try {
        const plan = await planLegacyTrayRecycle(ownerPid ?? undefined);
        return {
          disposition: "recycle",
          reasonCode: "TRAY_LEGACY_PROVABLE",
          note: "Legacy Tray binary provable and trusted; guarded native migration available.",
          childPlan: plan as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          disposition: "blocked",
          reasonCode: "TRAY_RECYCLE_BLOCKED",
          note:
            "Tray legacy migration blocked: " +
            (err instanceof Error ? err.message : String(err)),
        };
      }
    }
    return {
      disposition: "skip_inactive",
      reasonCode: "TRAY_INACTIVE",
      note: "No Tray running; launch on demand.",
    };
  }

  if (service === "daemon") {
    return {
      disposition: "verify_only",
      reasonCode: "DAEMON_EMBEDDED",
      note: "Daemon scheduler is embedded in Core; verified automatically with Core.",
    };
  }

  if (service === "guardian") {
    if (ownershipVerified && state === "active") {
      return {
        disposition: "keep",
        reasonCode: "GUARDIAN_MANAGED_HEALTHY",
        note: "Guardian watchdog verified; keep active.",
      };
    }
    return {
      disposition: "skip_inactive",
      reasonCode: "GUARDIAN_INACTIVE",
      note: "Guardian watchdog inactive; do not force start.",
    };
  }

  if (service === "transport") {
    if (ownershipVerified && state === "active") {
      return {
        disposition: "keep",
        reasonCode: "TRANSPORT_MANAGED_HEALTHY",
        note: "Transport frontdoor verified; keep active.",
      };
    }
    return {
      disposition: "skip_inactive",
      reasonCode: "TRANSPORT_INACTIVE",
      note: "Transport host inactive; skip.",
    };
  }

  if (
    service === "channel_host" ||
    service === "muse" ||
    service === "telegram"
  ) {
    if (ownershipVerified && state === "active") {
      return {
        disposition: "keep",
        reasonCode: `${service.toUpperCase()}_MANAGED_HEALTHY`,
        note: `${service} channel verified; keep active.`,
      };
    }
    return {
      disposition: "skip_inactive",
      reasonCode: `${service.toUpperCase()}_INACTIVE`,
      note: `${service} inactive; skip.`,
    };
  }

  if (service === "rest_tunnel" || service === "muse_tunnel") {
    if (state === "active") {
      return {
        disposition: "keep",
        reasonCode: "TUNNEL_PRESERVED",
        note: "Public ingress tunnel active; preserved without mutation.",
      };
    }
    return {
      disposition: "skip_inactive",
      reasonCode: "TUNNEL_INACTIVE",
      note: "Public ingress tunnel inactive; preserved without mutation.",
    };
  }

  if (service === "process_supervisor") {
    return {
      disposition: "verify_only",
      reasonCode: "PROCESS_SUPERVISOR_EMBEDDED",
      note: "Process supervisor is in-process registry; verify only.",
    };
  }

  return {
    disposition: "skip_inactive",
    reasonCode: "UNKNOWN_SERVICE_DEFAULT",
    note: "Service state inspected read-only.",
  };
}

/**
 * Plans a global lifecycle recycle operation across all services.
 */
export async function planGlobalLifecycleRecycle(): Promise<GlobalRecyclePlan> {
  const statuses = await inspectServices("all");
  const operationId = crypto.randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + 5 * 60 * 1000; // 5-minute bounded plan

  const children: GlobalRecycleChildPlan[] = [];

  for (const name of DEFAULT_DEPENDENCY_ORDER) {
    const status = statuses.find((s) => s.service === name);
    if (!status) continue;

    const { disposition, reasonCode, note, childPlan } =
      await determineServiceDisposition(status);

    children.push({
      service: name,
      disposition,
      reasonCode,
      note,
      ...(status.port ? { port: status.port } : {}),
      ...(status.ownerPid ? { expectedOwnerPid: status.ownerPid } : {}),
      ...(childPlan?.operationId
        ? { operationId: childPlan.operationId as string }
        : {}),
      ...(childPlan?.expectedProcessIdentity
        ? {
            expectedProcessIdentity:
              childPlan.expectedProcessIdentity as string,
          }
        : {}),
      ...(childPlan?.expectedBuildDigest
        ? { expectedBuildDigest: childPlan.expectedBuildDigest as string }
        : {}),
      dependencyState: [],
      ...(childPlan ? { childPlan } : {}),
    });
  }

  const mutations = children.filter((c) =>
    ["recycle", "start", "restart", "reload"].includes(c.disposition)
  ).length;
  const noops = children.filter((c) =>
    ["keep", "skip_inactive", "verify_only"].includes(c.disposition)
  ).length;
  const blocked = children.filter((c) => c.disposition === "blocked").length;

  const plan: GlobalRecyclePlan = {
    version: 1,
    operationId,
    createdAt,
    expiresAt,
    dependencyOrder: DEFAULT_DEPENDENCY_ORDER,
    children,
    summary: {
      total: children.length,
      mutations,
      noops,
      blocked,
    },
    publicTunnelMutationAllowed: false,
    arbitraryPidKillAllowed: false,
    note: "Global Lifecycle Recycle Plan: read-only evaluation of all service owners and dispositions. Public tunnels and OAuth sessions are preserved without mutation.",
  };

  const ledger = new GlobalRecycleLedger();
  ledger.recordPlan(plan);

  recordLifecycleEvent({
    at: createdAt,
    service: "process_supervisor",
    action: "recycle",
    outcome: "planned",
    operationHashPrefix: operationHashPrefix(operationId),
  });

  return plan;
}

/**
 * Executes a planned global lifecycle recycle operation.
 */
export async function executeGlobalLifecycleRecycle(
  plan: GlobalRecyclePlan,
  confirm: boolean
) {
  if (confirm !== true) throw new Error('GLOBAL_RECYCLE_EXPLICIT_CONFIRMATION_REQUIRED');
  const lockPath = globalRecycleLedgerPath() + '.execution.lock';
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  if (fs.lstatSync(path.dirname(lockPath)).isSymbolicLink())
    throw new Error('GLOBAL_RECYCLE_UNSAFE_LEDGER_DIRECTORY');
  let fd: number;
  try { fd = fs.openSync(lockPath, 'wx', 0o600); }
  catch { throw new Error('GLOBAL_RECYCLE_EXECUTION_IN_PROGRESS_OR_ORPHAN_LOCK'); }
  try { return await executeGlobalLifecycleRecycleLocked(plan, confirm); }
  finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lockPath); } catch { /* orphan lock requires operator inspection */ }
  }
}

async function executeGlobalLifecycleRecycleLocked(
  plan: GlobalRecyclePlan,
  confirm: boolean
) {
  if (confirm !== true) {
    throw new Error("GLOBAL_RECYCLE_EXPLICIT_CONFIRMATION_REQUIRED");
  }

  if (Date.now() > plan.expiresAt) {
    throw new Error("GLOBAL_RECYCLE_PLAN_EXPIRED: plan exceeded 5-minute validity window");
  }

  const ledger = new GlobalRecycleLedger();
  const existing = ledger.lookup(plan.operationId);
  if (!existing?.plan || !existing.planDigest ||
      existing.planDigest !== digestGlobalPlan(existing.plan) ||
      existing.planDigest !== digestGlobalPlan(plan)) {
    throw new Error('GLOBAL_RECYCLE_PLAN_FINGERPRINT_MISMATCH');
  }
  if (existing.status === "completed" || existing.status === "reconciled") {
    return {
      action: "recycle",
      service: "all",
      replayed: true,
      changed: false,
      operationId: plan.operationId,
      status: existing.status,
      childResults: existing.childResults,
      note: "Global recycle operation was already completed/reconciled with this operation ID.",
    };
  }

  if (existing.status !== 'planned') {
    throw new Error('GLOBAL_RECYCLE_IN_PROGRESS_OR_UNCERTAIN_RECONCILE_FIRST');
  }
  if (plan.publicTunnelMutationAllowed !== false || plan.arbitraryPidKillAllowed !== false) {
    throw new Error('GLOBAL_RECYCLE_SAFETY_INVARIANT_MISMATCH');
  }
  if (plan.children.some(c => !['keep','skip_inactive','verify_only','recycle','blocked'].includes(c.disposition))) {
    throw new Error('GLOBAL_RECYCLE_UNSUPPORTED_CHILD_MUTATION');
  }
  // Check if any child was blocked at plan time
  const blockedChild = plan.children.find((c) => c.disposition === "blocked");
  if (blockedChild) {
    throw new Error(
      `GLOBAL_RECYCLE_CHILD_BLOCKED: ${blockedChild.service} is blocked (${blockedChild.reasonCode}: ${blockedChild.note})`
    );
  }

  const observed = await inspectServices('all');
  for (const child of plan.children) {
    const current = observed.find(s => s.service === child.service);
    if (!current) throw new Error('GLOBAL_RECYCLE_SERVICE_DISAPPEARED');
    if (child.disposition === 'keep' &&
        (!current.ownershipVerified || current.ownerPid !== (child.expectedOwnerPid ?? null))) {
      throw new Error('GLOBAL_RECYCLE_PRESERVED_OWNER_CHANGED');
    }
    if (child.disposition === 'skip_inactive' && current.state !== 'inactive') {
      throw new Error('GLOBAL_RECYCLE_INACTIVE_SERVICE_CHANGED');
    }
  }
  ledger.updatePhase(plan.operationId, 'precheck');
  const started = Date.now();

  recordLifecycleEvent({
    at: started,
    service: "process_supervisor",
    action: "recycle",
    outcome: "planned",
    operationHashPrefix: operationHashPrefix(plan.operationId),
  });

  const childResults: GlobalRecycleLedgerEntry["childResults"] = [];

  try {
    for (const serviceName of plan.dependencyOrder) {
      const childPlan = plan.children.find((c) => c.service === serviceName);
      if (!childPlan) continue;

      // Safe no-ops
      if (
        childPlan.disposition === "keep" ||
        childPlan.disposition === "skip_inactive" ||
        childPlan.disposition === "verify_only"
      ) {
        const item: GlobalRecycleLedgerEntry["childResults"][number] = {
          service: serviceName,
          disposition: childPlan.disposition,
          changed: false,
          replayed: false,
          previousPid: childPlan.expectedOwnerPid ?? null,
          ownerPid: childPlan.expectedOwnerPid ?? null,
          status: "skipped",
          note: childPlan.note,
        };
        childResults.push(item);
        ledger.updatePhase(plan.operationId, "migrating", item);
        continue;
      }

      if (childPlan.disposition === "recycle") {
        ledger.updatePhase(plan.operationId, "migrating");

        if (serviceName === "core") {
          const corePlan = childPlan.childPlan as unknown as LegacyCoreRecyclePlan;
          if (!corePlan) {
            throw new Error("GLOBAL_RECYCLE_MISSING_CORE_PLAN");
          }
          const res = await scheduleLegacyCoreRecycle(corePlan, true);
          if (res.scheduled) {
            throw new Error('GLOBAL_RECYCLE_CORE_ASYNC_PENDING_OWNER_ATTESTATION');
          }
          const item: GlobalRecycleLedgerEntry["childResults"][number] = {
            service: "core",
            disposition: "recycle",
            changed: res.changed,
            replayed: res.replayed,
            previousPid: res.previousPid ?? childPlan.expectedOwnerPid ?? null,
            ownerPid: res.ownerPid ?? null,
            status: "succeeded",
            note: res.note,
          };
          childResults.push(item);
          ledger.updatePhase(plan.operationId, "migrating", item);
        } else if (serviceName === "tray") {
          const trayPlan = childPlan.childPlan as unknown as LegacyTrayRecyclePlan;
          if (!trayPlan) {
            throw new Error("GLOBAL_RECYCLE_MISSING_TRAY_PLAN");
          }
          const res = await executeLegacyTrayRecycle(trayPlan, true);
          const item: GlobalRecycleLedgerEntry["childResults"][number] = {
            service: "tray",
            disposition: "recycle",
            changed: res.changed,
            replayed: res.replayed,
            previousPid: res.previousPid ?? childPlan.expectedOwnerPid ?? null,
            ownerPid: res.ownerPid ?? null,
            status: "succeeded",
            note: res.note,
          };
          childResults.push(item);
          ledger.updatePhase(plan.operationId, "migrating", item);
        } else if (serviceName === "vision") {
          const visionPlan = childPlan.childPlan as unknown as LegacyVisionRecyclePlan;
          if (!visionPlan) {
            throw new Error("GLOBAL_RECYCLE_MISSING_VISION_PLAN");
          }
          const res = await executeLegacyVisionRecycle(visionPlan, true);
          const item: GlobalRecycleLedgerEntry["childResults"][number] = {
            service: "vision",
            disposition: "recycle",
            changed: res.changed,
            replayed: res.replayed,
            previousPid: res.previousPid ?? childPlan.expectedOwnerPid ?? null,
            ownerPid: res.ownerPid ?? null,
            status: "succeeded",
            note: res.note,
          };
          childResults.push(item);
          ledger.updatePhase(plan.operationId, "migrating", item);
        }
      }
    }

    ledger.complete(plan.operationId);

    recordLifecycleEvent({
      at: Date.now(),
      service: "process_supervisor",
      action: "recycle",
      outcome: "succeeded",
      operationHashPrefix: operationHashPrefix(plan.operationId),
      durationMs: Date.now() - started,
    });

    return {
      action: "recycle",
      service: "all",
      replayed: false,
      changed: true,
      operationId: plan.operationId,
      status: "completed",
      childResults,
      note: "Global Lifecycle Recycle completed successfully.",
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    ledger.fail(plan.operationId, "partial", errorMsg);

    recordLifecycleEvent({
      at: Date.now(),
      service: "process_supervisor",
      action: "recycle",
      outcome: "uncertain",
      operationHashPrefix: operationHashPrefix(plan.operationId),
      durationMs: Date.now() - started,
      errorCode:
        err instanceof Error
          ? err.message.match(/[A-Z0-9_]{3,60}/)?.[0] ?? "GLOBAL_RECYCLE_FAILED"
          : "GLOBAL_RECYCLE_FAILED",
    });

    throw err;
  }
}

/**
 * Reconciles an interrupted or uncertain global recycle operation.
 */
export async function reconcileGlobalLifecycleRecycle(
  operationId: string,
  reviewed: boolean
) {
  validateCoreOperationId(operationId);
  const ledger = new GlobalRecycleLedger();
  const entry = ledger.reconcile(operationId, reviewed);

  recordLifecycleEvent({
    at: Date.now(),
    service: "process_supervisor",
    action: "recycle",
    outcome: "succeeded",
    operationHashPrefix: operationHashPrefix(operationId),
  });

  return {
    action: "reconcile",
    service: "all",
    operationId,
    status: entry.status,
    childResults: entry.childResults,
    note: "Global recycle transaction reconciled without mutation re-execution.",
  };
}
