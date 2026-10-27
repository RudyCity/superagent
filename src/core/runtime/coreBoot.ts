/**
 * Safe login-time Core bootstrap. It never replays accepted work or deletes
 * recovery evidence. After a verified total runtime loss (for example a real
 * Windows reboot), stale owner/routing files may be archived before starting a
 * fresh guardian.
 */
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { coreCheckpointPath, readCoreCheckpoint } from "./coreSupervisorCheckpoint.js";
import { requestCoreSupervisor, runCoreSupervisor } from "./coreSupervisor.js";
import { coreGuardianFile, runCoreGuardian } from "./coreGuardian.js";
import { auditCoreColdStart } from "./coreColdStartAudit.js";
import { archiveVerifiedColdRuntimeState } from "./coreColdReset.js";

export type CoreBootDecision =
  "already_running" | "fresh_guard" | "recover_survivors" | "cold_reset" | "refuse";
export interface CoreBootSnapshot {
  checkpointPresent: boolean;
  discoveryPresent: boolean;
  guardianLeasePresent: boolean;
  verifiedRunningOwner: boolean;
  checkpointValid: boolean;
  checkpointModeMatches: boolean;
  coldResetAllowed?: boolean;
}
export function decideCoreBoot(snapshot: CoreBootSnapshot): CoreBootDecision {
  if (snapshot.verifiedRunningOwner) return "already_running";
  if (snapshot.coldResetAllowed) return "cold_reset";
  if (snapshot.guardianLeasePresent) return "refuse";
  if (snapshot.checkpointPresent) {
    if (!snapshot.checkpointValid || !snapshot.checkpointModeMatches) return "refuse";
    return "recover_survivors";
  }
  return snapshot.discoveryPresent ? "refuse" : "fresh_guard";
}

export async function runCoreBoot(options: {
  port: number; clientMode?: "tline" | "chrome-extension";
}): Promise<"already_running" | "started" | "recovered" | "cold_started"> {
  const port = options.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid Core boot port");

  let running = false;
  try {
    const state = await requestCoreSupervisor("status", port, 1600);
    running = state.publicPort === port && state.supervisorPid > 0 && state.active.pid > 0;
  } catch { /* absence is not authorization to delete persisted state */ }

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
    } catch { /* corrupt checkpoint always fails closed */ }
  }

  const cold = running ? null : await auditCoreColdStart(port);
  const snapshot: CoreBootSnapshot = {
    checkpointPresent,
    discoveryPresent: fs.existsSync(path.join(home, "core-supervisor-" + port + ".json")),
    guardianLeasePresent: fs.existsSync(coreGuardianFile(port)),
    verifiedRunningOwner: running,
    checkpointValid,
    checkpointModeMatches,
    coldResetAllowed: cold?.assessment.decision === "cold_reset_allowed" &&
      cold.assessment.mayArchiveStaleRuntime === true,
  };

  const decision = decideCoreBoot(snapshot);
  if (decision === "already_running") {
    console.log("Core boot: verified owner already active; no takeover or restart.");
    return "already_running";
  }

  const mode = options.clientMode || storedMode || "tline";
  if (decision === "recover_survivors") {
    // Recovery authenticates the original worker generation and never replays
    // unfinished tool/chat work.
    await runCoreSupervisor(port, mode, true);
    console.log("Core boot: existing worker(s) verified; checkpoint routing restored.");
    return "recovered";
  }

  if (decision === "cold_reset") {
    const archive = await archiveVerifiedColdRuntimeState(port);
    console.log(
      "Core boot: verified total runtime loss; stale state archived at " +
      archive.archiveDir + ". No previous session or tool effect was replayed.",
    );
    const result = await runCoreGuardian({ port, clientMode: mode });
    if (result.reason !== "stopped")
      throw new Error("Cold-start Core guardian exited: " + result.reason);
    return "cold_started";
  }

  if (decision === "refuse") {
    throw new Error(
      "Core boot refused: runtime evidence requires operator ownership review. " +
      "No files were reset and no processes were stopped.");
  }

  const result = await runCoreGuardian({ port, clientMode: mode });
  if (result.reason !== "stopped") throw new Error("Fresh Core guardian exited: " + result.reason);
  return "started";
}
