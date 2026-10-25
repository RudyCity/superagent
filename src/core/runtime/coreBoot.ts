/**
 * Safe login-time Core bootstrap. Does not clear stale state, adopt an
 * unverified owner or replay any work. A cold reboot with no surviving worker
 * is intentionally NOT a recoverable session without operator review.
 */
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { coreCheckpointPath, readCoreCheckpoint } from "./coreSupervisorCheckpoint.js";
import { requestCoreSupervisor, runCoreSupervisor } from "./coreSupervisor.js";
import { coreGuardianFile, runCoreGuardian } from "./coreGuardian.js";
export type CoreBootDecision = "already_running" | "fresh_guard" | "recover_survivors" | "refuse";
export interface CoreBootSnapshot {
  checkpointPresent: boolean;
  discoveryPresent: boolean;
  guardianLeasePresent: boolean;
  verifiedRunningOwner: boolean;
  checkpointValid: boolean;
  checkpointModeMatches: boolean;
}
export function decideCoreBoot(snapshot: CoreBootSnapshot): CoreBootDecision {
  if (snapshot.verifiedRunningOwner) return "already_running";
  if (snapshot.guardianLeasePresent) return "refuse";
  if (snapshot.checkpointPresent) {
    if (!snapshot.checkpointValid || !snapshot.checkpointModeMatches) return "refuse";
    return "recover_survivors";
  }
  return snapshot.discoveryPresent ? "refuse" : "fresh_guard";
}
export async function runCoreBoot(options: {
  port: number; clientMode?: "tline" | "chrome-extension";
}): Promise<"already_running" | "started" | "recovered"> {
  const port = options.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Core boot port");
  let running = false;
  try {
    const state = await requestCoreSupervisor("status", port, 1600);
    running = state.publicPort === port && state.supervisorPid > 0 && state.active.pid > 0;
  } catch { /* not an authorization to delete existing state */ }
  const home = getRootConfigDir();
  const cpFile = coreCheckpointPath(port);
  const checkpointPresent = fs.existsSync(cpFile);
  let checkpointValid = false;
  let checkpointModeMatches = false;
  let storedMode: "tline" | "chrome-extension" | undefined;
  if (checkpointPresent) {
    try {
      const checkpoint = readCoreCheckpoint(port);
      checkpointValid = true;
      storedMode = checkpoint.clientMode;
      checkpointModeMatches = !options.clientMode || options.clientMode === storedMode;
    } catch { /* corrupt checkpoint must always fail closed */ }
  }
  const snapshot: CoreBootSnapshot = {
    checkpointPresent,
    discoveryPresent: fs.existsSync(path.join(home, "core-supervisor-" + port + ".json")),
    guardianLeasePresent: fs.existsSync(coreGuardianFile(port)),
    verifiedRunningOwner: running, checkpointValid, checkpointModeMatches,
  };
  const decision = decideCoreBoot(snapshot);
  if (decision === "already_running") {
    console.log("Core boot: verified owner already active; no takeover or restart.");
    return "already_running";
  }
  if (decision === "refuse") throw new Error(
    "Core boot refused: lease, checkpoint or discovery requires operator ownership review. " +
    "No files were reset and no processes were stopped.");
  const mode = options.clientMode || storedMode || "tline";
  if (decision === "recover_survivors") {
    // runCoreSupervisor verifies the original worker generation's PID,
    // private inspection token and authenticated readiness before rebinding.
    // If ALL workers died in a reboot, this MUST fail.
    await runCoreSupervisor(port, mode, true);
    console.log("Core boot: existing worker(s) verified; checkpoint routing restored. Guardian was not auto-adopted.");
    return "recovered";
  }
  // Fresh boot has no routing checkpoint, stale owner or guardian lease.
  const result = await runCoreGuardian({ port, clientMode: mode });
  if (result.reason !== "stopped") throw new Error("Fresh Core guardian exited: " + result.reason);
  return "started";
}
