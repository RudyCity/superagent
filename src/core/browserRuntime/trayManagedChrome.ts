/**
 * Fixed-shape owner-only Chrome CDP actions for the native SuperAgent Tray.
 * This is NOT registered as an MCP tool. The HTTP route enforces local ingress
 * and Core bearer; native Tray requires its own focused operator confirmation.
 */
import { getBrowserProcessManager, type BrowserProcessManager } from "./browserProcessManager.js";
import { planManagedChromeLaunch } from "./managedChromeLaunchPlan.js";
import { readProcessStartIdentity, compareProcessStartIdentity } from "../tools/cliBridgeProcessIdentity.js";

export type TrayChromeAction = "status" | "launch" | "stop";

function exactObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Error("MANAGED_CDP_INVALID_REQUEST");
  }
  const object = input as Record<string, unknown>;
  if (Object.keys(object).some(k => !keys.includes(k))) throw Error("MANAGED_CDP_UNEXPECTED_FIELD");
  return object;
}

function portOf(raw: unknown): number {
  const port = raw === undefined ? 9222 : raw;
  if (!Number.isSafeInteger(port) || Number(port) < 1024 || Number(port) > 65535)
    throw Error("MANAGED_CDP_INVALID_PORT");
  return Number(port);
}

/** Serialization intentionally omits filesystem paths, launch flags and CDP secrets. */
export async function trayManagedChromeAction(
  input: unknown,
  manager: BrowserProcessManager = getBrowserProcessManager(),
): Promise<Record<string, unknown>> {
  const envelope = exactObject(input, ["action", "port", "mode", "url", "confirm", "expectedPid", "recordId"]);
  const action = envelope.action;
  if (!["status", "launch", "stop"].includes(String(action)))
    throw Error("MANAGED_CDP_UNKNOWN_ACTION");
  const port = portOf(envelope.port);
  if (action === "status") {
    if (Object.keys(envelope).some(k => !["action", "port"].includes(k)))
      throw Error("MANAGED_CDP_UNEXPECTED_FIELD");
    const health = await manager.checkHealth(port);
    const tracked = manager.getActiveInstance(port);
    const birth = tracked?.creationIdentity && await readProcessStartIdentity(tracked.pid);
    const pidVerified = Boolean(tracked?.creationIdentity && birth &&
      compareProcessStartIdentity(tracked.creationIdentity, birth) === "matched_unverified");
    const endpointVerified = health.status === "healthy" &&
      Boolean(tracked?.browserFingerprint && tracked.browserFingerprint === health.browserFingerprint);
    // A verified owned PID may outlive its CDP listener. Permit an attended
    // exact-PID Stop in that case, but never when a different endpoint owns the port.
    const owned = pidVerified && (endpointVerified || !health.listening);
    return {
      success: true, port, host: "127.0.0.1", status: health.status,
      reachable: health.status === "healthy", occupied: health.listening,
      owned, canStop: owned, pid: owned ? tracked?.pid : null,
      recordId: owned ? tracked?.recordId : null,
      browserVersion: health.browserVersion || null,
      targetCount: health.status === "healthy" ? (health.targetCount ?? 0) : null,
      reason: health.listening && !owned ? "Existing CDP endpoint is not verified as an owned SuperAgent process" :
        !health.listening && tracked ? "Previously tracked Chrome is no longer reachable" : null,
    };
  }
  if (action === "launch") {
    const payload = exactObject(input, ["action", "port", "mode", "url", "confirm"]);
    if (payload.confirm !== true) throw Error("MANAGED_CDP_CONFIRM_REQUIRED");
    const mode = payload.mode === undefined ? "headed" : payload.mode;
    if (!["auto", "headed", "headless"].includes(String(mode)))
      throw Error("MANAGED_CDP_INVALID_MODE");
    if (payload.url !== undefined && typeof payload.url !== "string")
      throw Error("MANAGED_CDP_INVALID_URL");
    const plan = planManagedChromeLaunch({
      port, url: payload.url as string | undefined, isolated: true, profileName: "Default",
    }, p => manager.getDefaultUserDataDir(p));
    const instance = await manager.launchBrowser({
      port: plan.port, host: plan.host, userDataDir: plan.userDataDir,
      profileName: plan.profileName, url: plan.url, mode: mode as "auto" | "headed" | "headless",
      useFakeMediaUi: false,
    });
    const after = await trayManagedChromeAction({ action: "status", port }, manager);
    if (after.owned !== true || after.pid !== instance.pid)
      throw Error("MANAGED_CDP_LAUNCHED_BUT_NOT_VERIFIED");
    return { ...after, launched: !instance.reused, reused: Boolean(instance.reused) };
  }
  const payload = exactObject(input, ["action", "port", "confirm", "expectedPid", "recordId"]);
  if (payload.confirm !== true) throw Error("MANAGED_CDP_CONFIRM_REQUIRED");
  if (!Number.isSafeInteger(payload.expectedPid) || Number(payload.expectedPid) <= 0 ||
      typeof payload.recordId !== "string" || payload.recordId.length < 6 || payload.recordId.length > 180)
    throw Error("MANAGED_CDP_STOP_IDENTITY_REQUIRED");
  const before = await trayManagedChromeAction({ action: "status", port }, manager);
  if (before.owned !== true || before.pid !== payload.expectedPid ||
      before.recordId !== payload.recordId)
    throw Error("MANAGED_CDP_STOP_OWNER_MISMATCH");
  const result = await manager.stopBrowser({
    port, pid: Number(payload.expectedPid), recordId: String(payload.recordId),
  });
  if (!result.success) throw Error("MANAGED_CDP_STOP_NOT_CONFIRMED");
  const after = await manager.checkHealth(port);
  if (after.listening) throw Error("MANAGED_CDP_STOP_PORT_STILL_ACTIVE");
  return { success: true, stopped: true, port, pid: payload.expectedPid, status: "stopped", owned: false };
}
