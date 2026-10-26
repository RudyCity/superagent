/**
 * Phase 5g — evidence-bound, READ-ONLY recovery reconciliation.
 * This code NEVER authorizes cold start, discards history, executes tools or
 * transitions a session to safe. Its inputs are a verified offline snapshot.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getRootConfigDir } from "../config/paths.js";
import type { CoreRecoveryEvidenceResult } from "./coreRecoveryEvidence.js";
const require = createRequire(import.meta.url);
const { Database } = require("bun:sqlite") as { Database: new(file: string, opts: { readonly: boolean }) => {
  query(sql: string): { all(): any[]; get(): any }; close(): void;
}};
export interface CoreReconciliationReport {
  version: 1; port: number; snapshotId: string;
  evidenceVerified: boolean; snapshotIntegrity: "ok" | "absent";
  checkpointPresent: boolean; receipts: number;
  chatTurnStateCounts: Record<string, number>;
  unfinishedTurnCount: number; persistedSessionCount: number | null;
  requiresExternalEffectReview: true;
  requiresHumanOperatorReview: true;
  restartAuthorized: false; toolsMayReplay: false;
  findings: string[];
}
function sha(file: string) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const h=crypto.createHash("sha256");
  try {
    const b=Buffer.alloc(64*1024); let n=0;
    while ((n=fs.readSync(fd,b,0,b.length,null))>0) h.update(b.subarray(0,n));
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}
function safeFile(file: string) {
  const stat=fs.lstatSync(file);
  if (!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024*1024) throw new Error("Unsafe recovery evidence file");
}
export function reconcileCoreRecoveryEvidence(snapshotFolder: string): CoreReconciliationReport {
  const root=path.resolve(getRootConfigDir(),"recovery-evidence");
  const folder=path.resolve(snapshotFolder);
  if (path.dirname(folder)!==root || !path.basename(folder).startsWith("core-")) {
    throw new Error("Recovery evidence must belong to configured local owner");
  }
  for(const dir of [getRootConfigDir(),root,folder]) {
    const st=fs.lstatSync(dir);
    if (!st.isDirectory()||st.isSymbolicLink()) throw new Error("Unsafe evidence directory");
  }
  const manifestPath=path.join(folder,"manifest.json");
  safeFile(manifestPath);
  const raw=fs.readFileSync(manifestPath,"utf8");
  if (raw.length>256*1024) throw new Error("Recovery manifest too large");
  const manifest=JSON.parse(raw) as CoreRecoveryEvidenceResult;
  if(manifest.version!==1||!Number.isInteger(manifest.port)||manifest.port<1||manifest.port>65535||
     manifest.folder!==folder||manifest.restartAuthorized!==false||
     manifest.toolReplayAuthorized!==false||manifest.originalsModified!==false||
     !Array.isArray(manifest.files)||manifest.files.length>20003||
     !manifest.database||!["ok","absent"].includes(manifest.database.integrity)) {
    throw new Error("Invalid recovery manifest");
  }
  const names=new Set<string>();
  let receipts=0,checkpointPresent=false;
  for(const file of manifest.files) {
    if (!file || typeof file.name!=="string" ||
        !/^(core-checkpoint\.json|core-supervisor\.json|core-guardian\.json|receipts\/[a-f0-9]{2}\/[a-f0-9]{64}\.json)$/.test(file.name)||
        names.has(file.name)||!Number.isSafeInteger(file.bytes)||file.bytes<1||
        !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid recovery manifest entry");
    names.add(file.name);
    const target=path.join(folder,...file.name.split("/"));
    const base=path.dirname(target);
    if (base!==folder) {
      for(const dir of [path.dirname(base),base]) {
        const stat=fs.lstatSync(dir);
        if(!stat.isDirectory()||stat.isSymbolicLink()) throw new Error("Unsafe evidence subfolder");
      }
    }
    safeFile(target);
    if(fs.statSync(target).size!==file.bytes||sha(target)!==file.sha256)
      throw new Error("Recovery evidence integrity mismatch");
    if (file.name==="core-checkpoint.json") checkpointPresent=true;
    if (file.name.startsWith("receipts/")) receipts++;
  }
  const counts:Record<string,number>={};
  let sessions:number|null=null;
  if(manifest.database.present===true){
    if (manifest.database.integrity!=="ok" ||
        !/^[a-f0-9]{64}$/.test(manifest.database.sha256||"") ||
        !Number.isSafeInteger(manifest.database.bytes)||manifest.database.bytes!<1) {
      throw new Error("Unverified recovery database");
    }
    const target=path.join(folder,"history.db");
    safeFile(target);
    if(fs.statSync(target).size!==manifest.database.bytes||sha(target)!==manifest.database.sha256)
      throw new Error("Recovery SQLite hash mismatch");
    const db=new Database(target,{readonly:true});
    try {
      if((db.query("PRAGMA integrity_check").get() as any)?.integrity_check!=="ok")
        throw new Error("Corrupt recovered SQLite");
      const tables=db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chat_turns','sessions')").all() as Array<{name:string}>;
      if(tables.some(t=>t.name==="chat_turns")) {
        const rows=db.query("SELECT state,COUNT(*) AS total FROM chat_turns GROUP BY state").all() as Array<{state:string;total:number}>;
        for(const row of rows) {
          if(typeof row.state!=="string"||row.state.length>40||!Number.isSafeInteger(row.total)||row.total<0)
            throw new Error("Unverifiable turn state");
          counts[row.state]=row.total;
        }
      }
      if(tables.some(t=>t.name==="sessions")) {
        const row=db.query("SELECT COUNT(*) AS total FROM sessions").get() as {total:number};
        sessions=Number.isSafeInteger(row?.total)?row.total:null;
      }
    } finally {db.close();}
  } else if (manifest.database.integrity!=="absent") throw new Error("Inconsistent database manifest");
  const unfinished=Object.entries(counts).reduce((sum,[state,count])=>
    sum+(["completed","cancelled","failed"].includes(state)?0:count),0);
  const findings=[
    ...(checkpointPresent?["CHECKPOINT_REQUIRES_EXPLICIT_OWNER_RECONCILIATION"]:[]),
    ...(receipts?["PERSISTED_SESSION_RECEIPTS_REQUIRE_REVIEW"]:[]),
    ...(unfinished?["INCOMPLETE_OR_UNKNOWN_CHAT_TURNS"]:[]),
    "EXTERNAL_TOOL_SIDE_EFFECTS_NOT_PROVEN_SAFE",
    "NO_AUTOMATIC_COLD_RESTART_OR_TOOL_REPLAY",
  ];
  return {version:1,port:manifest.port,snapshotId:path.basename(folder),
    evidenceVerified:true,snapshotIntegrity:manifest.database.integrity,
    checkpointPresent,receipts,chatTurnStateCounts:counts,
    unfinishedTurnCount:unfinished,persistedSessionCount:sessions,
    requiresExternalEffectReview:true,requiresHumanOperatorReview:true,
    restartAuthorized:false,toolsMayReplay:false,findings};
}
