/**
 * Guarded migration of an unmanaged/legacy Vision server into the
 * managed Vision lifecycle.
 *
 * No arbitrary PID kill. Requires verified listener PID, process birth identity,
 * active request draining, graceful HTTP shutdown, and replacement with a
 * token-authenticated managed Vision owner.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { getPackageRootDir, getRootConfigDir } from "../config/paths.js";
import { readListenerOwners } from "./coreMcpOwnershipAudit.js";
import { readProcessStartIdentity } from "../tools/cliBridgeProcessIdentity.js";
import { readLegacyCoreProcessDescriptor } from "./coreLegacyRecycle.js";
import { listActiveTunnels } from "../remoteAgent/cloudflareTunnel.js";
import {
  readVisionOwner,
  visionOwnerFile,
  inspectManagedVision,
} from "./managedVisionControl.js";
import { ManagedSidecarLedger, sidecarOperationFingerprint } from "./managedSidecarLedger.js";
import { validateCoreOperationId } from "./coreLifecycleLedger.js";
import { recordLifecycleEvent, operationHashPrefix } from "./lifecycleTimeline.js";

export type LegacyVisionRecyclePlan = {
  service: "vision";
  action: "recycle";
  port: number;
  operationId: string;
  expectedOwnerPid: number;
  expectedProcessIdentity: string;
  expectedScriptDigest: string;
  supportsGracefulShutdown: boolean;
  noPublicIngress: true;
  note: string;
};

const validIdentity = (v: string) =>
  /^(?:win:\d{15,20}|linux:[a-f0-9-]{36}:\d+)$/.test(v);

function hashFile(file: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function visionScriptPath(): string {
  const script = path.join(getPackageRootDir(), "scripts", "vision_server.py");
  const stat = fs.lstatSync(script);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("VISION_RECYCLE_SCRIPT_UNSAFE");
  }
  return script;
}

let cachedPython: string | undefined;
function pythonBinary(): string {
  if (cachedPython) return cachedPython;
  const configured = process.env.SUPERAGENT_VISION_PYTHON || "python";
  const probe = spawnSync(configured, ["-c", "import sys; print(sys.executable)"], {
    windowsHide: true,
    timeout: 6000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const bin = probe.status === 0 ? probe.stdout.trim() : "";
  if (!path.isAbsolute(bin)) {
    throw new Error("VISION_RECYCLE_PYTHON_BINARY_UNRESOLVED");
  }
  cachedPython = bin;
  return bin;
}

function noIngress(port: number) {
  if (listActiveTunnels().some((t) => t.port === port)) {
    throw new Error("VISION_RECYCLE_PUBLIC_INGRESS_ATTACHED");
  }
}

async function probeHealth(port: number) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1800),
      redirect: "error",
    });
    if (!res.ok) return null;
    return (await res.json()) as {
      status: string;
      model_loaded: boolean;
      activeRequests?: number;
      supportsGracefulRecycle?: boolean;
      managed?: boolean;
      ownerPid?: number;
    };
  } catch {
    return null;
  }
}

export async function captureLegacyVisionEvidence(port = 8095) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || [7888, 8857, 9225, 9227].includes(port)) {
    throw new Error("VISION_RECYCLE_INVALID_OR_PROTECTED_PORT");
  }
  noIngress(port);

  const existingRecord = readVisionOwner(port);
  if (existingRecord) {
    throw new Error("VISION_RECYCLE_ALREADY_MANAGED: owner record exists, use restart instead");
  }

  const listeners = readListenerOwners();
  const ownerPid = listeners?.get(port);
  if (!ownerPid) {
    throw new Error("VISION_RECYCLE_NO_LISTENER");
  }

  const health = await probeHealth(port);
  if (!health) {
    throw new Error("VISION_RECYCLE_HEALTH_UNAVAILABLE");
  }

  const identity = await readProcessStartIdentity(ownerPid);
  if (!identity || !validIdentity(identity)) {
    throw new Error("VISION_RECYCLE_PROCESS_IDENTITY_UNAVAILABLE");
  }

  const script = visionScriptPath();
  const descriptor = readLegacyCoreProcessDescriptor(ownerPid);
  const command = descriptor.commandLine.replaceAll("/", "\\").toLowerCase();
  if (!/^python(?:w)?(?:\.exe)?$/i.test(path.basename(descriptor.executablePath)) ||
      !command.includes(script.replaceAll("/", "\\").toLowerCase())) {
    throw new Error("VISION_RECYCLE_LEGACY_COMMAND_NOT_TRUSTED");
  }
  const scriptDigest = hashFile(script);

  if (!Number.isSafeInteger(health.activeRequests) || Number(health.activeRequests) < 0) {
    throw new Error('VISION_RECYCLE_ACTIVE_REQUEST_COUNT_UNVERIFIED');
  }
  const secret = process.env.SUPERAGENT_VISION_LEGACY_RECYCLE_TOKEN || "";
  const supportsGraceful = health.supportsGracefulRecycle === true && /^[a-f0-9]{64}$/.test(secret);

  return {
    port,
    ownerPid,
    processIdentity: identity,
    scriptDigest,
    activeRequests: Number(health.activeRequests),
    supportsGracefulShutdown: supportsGraceful,
  };
}

export async function planLegacyVisionRecycle(port = 8095): Promise<LegacyVisionRecyclePlan> {
  const evidence = await captureLegacyVisionEvidence(port);
  if (evidence.activeRequests > 0) {
    throw new Error("VISION_RECYCLE_INFERENCE_ACTIVE: requests in flight, cannot plan recycle");
  }

  return {
    service: "vision",
    action: "recycle",
    port,
    operationId: crypto.randomUUID(),
    expectedOwnerPid: evidence.ownerPid,
    expectedProcessIdentity: evidence.processIdentity,
    expectedScriptDigest: evidence.scriptDigest,
    supportsGracefulShutdown: evidence.supportsGracefulShutdown,
    noPublicIngress: true,
    note: evidence.supportsGracefulShutdown
      ? "Guarded legacy Vision recycle: verifies port listener, process birth identity, ensures 0 active inference requests, issues graceful local shutdown, and restarts under tokenized managed owner."
      : "BLOCKED_GRACEFUL_STOP_UNAVAILABLE: legacy Vision instance does not expose a verified graceful shutdown channel; restart via managed owner or operator restart required.",
  };
}

function assertPlan(plan: LegacyVisionRecyclePlan) {
  if (
    plan.service !== "vision" ||
    plan.action !== "recycle" ||
    !Number.isSafeInteger(plan.port) ||
    plan.port < 1024 ||
    plan.port > 65535 ||
    !Number.isSafeInteger(plan.expectedOwnerPid) ||
    plan.expectedOwnerPid <= 0 ||
    !validIdentity(plan.expectedProcessIdentity) ||
    !/^[a-f0-9]{64}$/.test(plan.expectedScriptDigest) ||
    plan.noPublicIngress !== true
  ) {
    throw new Error("VISION_RECYCLE_INVALID_PLAN");
  }
  validateCoreOperationId(plan.operationId);
}

function recycleFingerprint(plan: LegacyVisionRecyclePlan) {
  return sidecarOperationFingerprint({
    service: "vision",
    action: "recycle",
    port: plan.port,
    expectedOwnerPid: plan.expectedOwnerPid,
    expectedProcessIdentity: plan.expectedProcessIdentity,
    expectedScriptDigest: plan.expectedScriptDigest,
    noPublicIngress: true,
  });
}

async function requestGracefulShutdown(port: number): Promise<void> {
  const secret = process.env.SUPERAGENT_VISION_LEGACY_RECYCLE_TOKEN || "";
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("VISION_RECYCLE_AUTH_UNAVAILABLE");
  const res = await fetch(`http://127.0.0.1:${port}/_superagent/vision/recycle_shutdown`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + secret },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    throw new Error("VISION_RECYCLE_GRACEFUL_SHUTDOWN_REFUSED");
  }
}

async function waitForPidExit(port: number, pid: number, expectedIdentity: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listeners = readListenerOwners();
    const identity = await readProcessStartIdentity(pid);
    if (identity && identity !== expectedIdentity) throw new Error("VISION_RECYCLE_PID_REUSED");
    if (!listeners?.has(port) && identity === null) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("VISION_RECYCLE_EXIT_TIMEOUT");
}

export async function executeLegacyVisionRecycle(
  plan: LegacyVisionRecyclePlan,
  confirm: boolean
) {
  assertPlan(plan);
  if (confirm !== true) {
    throw new Error("VISION_RECYCLE_EXPLICIT_CONFIRMATION_REQUIRED");
  }
  if (!plan.supportsGracefulShutdown) {
    throw new Error("VISION_RECYCLE_GRACEFUL_STOP_UNAVAILABLE");
  }

  const prior = new ManagedSidecarLedger('vision', plan.port)
    .lookup(plan.operationId, recycleFingerprint(plan));
  if (prior?.replayed) {
    return {service:'vision' as const,action:'recycle' as const,port:plan.port,
      changed:false,replayed:true,ownerPid:prior.afterPid??null};
  }

  noIngress(plan.port);

  // Pre-mutation verification
  const evidence = await captureLegacyVisionEvidence(plan.port);
  if (
    evidence.ownerPid !== plan.expectedOwnerPid ||
    evidence.processIdentity !== plan.expectedProcessIdentity
  ) {
    throw new Error("VISION_RECYCLE_OWNER_CHANGED_SINCE_PLAN");
  }

  const currentScriptDigest = hashFile(visionScriptPath());
  if (currentScriptDigest !== plan.expectedScriptDigest) {
    throw new Error("VISION_RECYCLE_SCRIPT_CHANGED_SINCE_PLAN");
  }

  if (evidence.activeRequests > 0) {
    throw new Error("VISION_RECYCLE_INFERENCE_ACTIVE");
  }

  const ledger = new ManagedSidecarLedger("vision", plan.port);
  const signature = recycleFingerprint(plan);
  const replay = ledger.lookup(plan.operationId, signature);
  if (replay?.replayed) {
    return {
      service: "vision",
      action: "recycle",
      port: plan.port,
      replayed: true,
      changed: false,
      ownerPid: replay.afterPid || null,
    };
  }

  const started = Date.now();
  ledger.begin(plan.operationId, signature);

  recordLifecycleEvent({
    at: started,
    service: "vision",
    action: "recycle",
    outcome: "planned",
    port: plan.port,
    ownerPid: plan.expectedOwnerPid,
    operationHashPrefix: operationHashPrefix(plan.operationId),
    buildDigestPrefix: plan.expectedScriptDigest.slice(0, 12),
  });

  try {
    // 1. Request graceful shutdown
    await requestGracefulShutdown(plan.port);

    // 2. Wait for port release and exit
    await waitForPidExit(plan.port, plan.expectedOwnerPid, plan.expectedProcessIdentity);

    // 3. Start managed Vision
    const instanceId = crypto.randomBytes(16).toString("hex");
    const token = crypto.randomBytes(32).toString("hex");
    const script = visionScriptPath();
    const child = spawn(
      pythonBinary(),
      [script, String(plan.port)],
      {
        cwd: getPackageRootDir(),
        windowsHide: true,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          SUPERAGENT_VISION_OWNER_TOKEN: token,
          SUPERAGENT_VISION_OWNER_INSTANCE: instanceId,
          SUPERAGENT_TRAY_AUTOSTART: "0",
        },
      }
    );
    child.on("error", () => {});
    child.unref();
    if (!child.pid) {
      throw new Error("VISION_RECYCLE_SPAWN_PID_MISSING");
    }

    const recordFile = visionOwnerFile(plan.port);
    fs.mkdirSync(path.dirname(recordFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      recordFile,
      JSON.stringify({
        version: 1,
        port: plan.port,
        pid: child.pid,
        instanceId,
        token,
      }),
      { flag: "wx", mode: 0o600 }
    );

    // 4. Verify managed attestation
    const deadline = Date.now() + 35000;
    let attestedPid: number | null = null;
    while (Date.now() < deadline) {
      const inspect = await inspectManagedVision(plan.port);
      if (inspect.verified && inspect.ownerPid === child.pid) {
        attestedPid = child.pid;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (!attestedPid) {
      throw new Error("VISION_RECYCLE_ATTESTATION_TIMEOUT");
    }

    ledger.complete(plan.operationId, attestedPid);

    recordLifecycleEvent({
      at: Date.now(),
      service: "vision",
      action: "recycle",
      outcome: "succeeded",
      port: plan.port,
      ownerPid: attestedPid,
      operationHashPrefix: operationHashPrefix(plan.operationId),
      buildDigestPrefix: plan.expectedScriptDigest.slice(0, 12),
      durationMs: Date.now() - started,
    });

    return {
      service: "vision",
      action: "recycle",
      port: plan.port,
      changed: true,
      replayed: false,
      previousPid: plan.expectedOwnerPid,
      ownerPid: attestedPid,
      note: "Legacy Vision server successfully migrated to tokenized managed owner.",
    };
  } catch (err) {
    try {
      recordLifecycleEvent({
        at: Date.now(),
        service: "vision",
        action: "recycle",
        outcome: "uncertain",
        port: plan.port,
        operationHashPrefix: operationHashPrefix(plan.operationId),
        buildDigestPrefix: plan.expectedScriptDigest.slice(0, 12),
        durationMs: Date.now() - started,
        errorCode:
          err instanceof Error
            ? err.message.match(/VISION_RECYCLE_[A-Z0-9_]+/)?.[0] ??
              "VISION_RECYCLE_FAILED"
            : "VISION_RECYCLE_FAILED",
      });
    } catch {}
    throw err;
  }
}
