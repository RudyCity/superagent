import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { coreCheckpointPath } from "./coreSupervisorCheckpoint.js";
import { coreGuardianFile } from "./coreGuardian.js";
import { auditCoreColdStart } from "./coreColdStartAudit.js";

export interface CoreColdResetArchive {
  version: 1;
  port: number;
  archivedAt: number;
  archiveDir: string;
  files: string[];
  reason: "VERIFIED_TOTAL_RUNTIME_LOSS_NO_REPLAY";
}

function safeRuntimeFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
      stat.size >= 0 && stat.size <= 8 * 1024 * 1024;
  } catch {
    return false;
  }
}

export async function archiveVerifiedColdRuntimeState(port: number): Promise<CoreColdResetArchive> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Invalid Core cold-reset port");
  }

  const evidence = await auditCoreColdStart(port);
  if (evidence.assessment.decision !== "cold_reset_allowed" ||
      evidence.assessment.mayArchiveStaleRuntime !== true ||
      evidence.assessment.automaticToolReplay !== false ||
      evidence.snapshot.externalEffectsReconciled !== true ||
      (evidence.snapshot.workers !== "all_dead" &&
       evidence.snapshot.checkpoint !== "absent")) {
    throw new Error("Cold reset refused: live evidence no longer proves safe total runtime loss");
  }

  const root = getRootConfigDir();
  const candidates = [
    coreCheckpointPath(port),
    path.join(root, "core-supervisor-" + port + ".json"),
    coreGuardianFile(port),
    path.join(root, "server-info-" + port + ".json"),
  ].filter(file => fs.existsSync(file));

  if (!candidates.length) {
    throw new Error("Cold reset refused: no stale runtime-control state to archive");
  }
  for (const file of candidates) {
    if (!safeRuntimeFile(file)) {
      throw new Error("Cold reset refused: unsafe runtime state file " + path.basename(file));
    }
  }

  const archiveRoot = path.join(root, "recovery-archive");
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  const archiveDir = path.join(
    archiveRoot,
    "core-" + port + "-" + new Date().toISOString().replace(/[:.]/g, "-") +
      "-" + crypto.randomBytes(4).toString("hex"),
  );
  fs.mkdirSync(archiveDir, { mode: 0o700 });

  const moved: Array<{ from: string; to: string }> = [];
  try {
    for (const from of candidates) {
      const to = path.join(archiveDir, path.basename(from));
      fs.renameSync(from, to);
      try { fs.chmodSync(to, 0o600); } catch {}
      moved.push({ from, to });
    }
    const manifest: CoreColdResetArchive = {
      version: 1,
      port,
      archivedAt: Date.now(),
      archiveDir,
      files: moved.map(item => path.basename(item.to)),
      reason: "VERIFIED_TOTAL_RUNTIME_LOSS_NO_REPLAY",
    };
    fs.writeFileSync(path.join(archiveDir, "manifest.json"), JSON.stringify({
      version: manifest.version,
      port: manifest.port,
      archivedAt: manifest.archivedAt,
      files: manifest.files,
      reason: manifest.reason,
      evidence: {
        ambiguousTurns: evidence.snapshot.ambiguousTurns,
        persistedReceipts: evidence.snapshot.persistedReceipts,
        receiptsWithAcceptedTurn: evidence.snapshot.receiptsWithAcceptedTurn,
        sessionReceiptsReconciled: evidence.snapshot.sessionReceiptsReconciled,
        workers: evidence.snapshot.workers,
        discoveryStale: evidence.snapshot.discoveryStale,
        guardianLeaseStale: evidence.snapshot.guardianLeaseStale,
      },
    }, null, 2), { mode: 0o600, flag: "wx" });
    return manifest;
  } catch (error) {
    for (const item of moved.slice().reverse()) {
      try {
        if (!fs.existsSync(item.from) && fs.existsSync(item.to)) fs.renameSync(item.to, item.from);
      } catch {}
    }
    try { fs.rmSync(archiveDir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}
