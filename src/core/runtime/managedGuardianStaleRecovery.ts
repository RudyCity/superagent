/**
 * Explicit recovery for orphaned managed-Guardian records after a Core
 * supervisor generation changes. Does not adopt or signal any process.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {getRootConfigDir} from "../config/paths.js";
import {readListenerOwners} from "./coreMcpOwnershipAudit.js";
import {requestCoreSupervisor} from "./coreSupervisor.js";
import {readCoreCheckpoint} from "./coreSupervisorCheckpoint.js";
import {coreGuardianFile,readCoreGuardianLease} from "./coreGuardian.js";
import {managedGuardianOwnerPath,readManagedGuardianOwner} from "./managedGuardianEntry.js";
import {inspectManagedGuardian} from "./managedGuardianControl.js";

type Evidence = {
  port:number;coreSupervisorPid:number;ownerPid:number;leasePid:number;
  previousSupervisorPid:number;controlPort:number;recordDigest:string;
};
const fingerprint=(a:string,b:string)=>crypto.createHash("sha256")
  .update(JSON.stringify([a,b])).digest("hex");

function safeRecord(file:string,maxBytes:number):string {
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<1||st.size>maxBytes)
    throw new Error("GUARDIAN_STALE_UNSAFE_RECORD");
  return fs.readFileSync(file,"utf8");
}

/** Null is not proof of absence: every OS probe must complete successfully. */
function absentProcesses(pids:number[]):boolean {
  if(pids.some(pid=>!Number.isSafeInteger(pid)||pid<=0))return false;
  if(process.platform==="win32") {
    const query=pids.map(pid=>"ProcessId = "+pid).join(" OR ");
    const command="$p=Get-CimInstance Win32_Process -Filter '"+query+
      "' -ErrorAction Stop; if ($null -ne $p) { $p | Select-Object -ExpandProperty ProcessId }";
    const result=execFileSync("powershell.exe",
      ["-NoProfile","-NonInteractive","-Command",command],
      {encoding:"utf8",timeout:6000,maxBuffer:4096,windowsHide:true});
    return result.trim()==="";
  }
  if(process.platform==="linux"){
    return pids.every(pid=>{
      try{fs.statSync("/proc/"+pid);return false;}
      catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return true;throw e;}
    });
  }
  throw new Error("GUARDIAN_STALE_OS_UNSUPPORTED");
}

export function assertGuardianStaleRecoverySafety(input:{
  coreSupervisorPid:number;previousSupervisorPid:number;
  ownerPid:number;leasePid:number;ownerPresent:boolean;
  controlPortBound:boolean;oldPidPresent:boolean;verifiedGuardian:boolean;
}):void {
  if(!input.ownerPresent||input.verifiedGuardian||
     input.controlPortBound||input.oldPidPresent||
     input.coreSupervisorPid===input.previousSupervisorPid||
     input.ownerPid===input.coreSupervisorPid||
     input.leasePid===input.coreSupervisorPid)
    throw new Error("GUARDIAN_STALE_RECOVERY_UNSAFE_OR_ACTIVE_OWNER");
}

async function inspect(port:number):Promise<Evidence> {
  if(!Number.isSafeInteger(port)||port<1024||port>65535)
    throw new Error("GUARDIAN_STALE_INVALID_PORT");
  const status=await requestCoreSupervisor("status",port,1800);
  const listeners=readListenerOwners();
  if(!listeners||status.publicPort!==port||status.supervisorPid<=0||
     status.ownerContract?.role!=="core-supervisor"||
     status.ownerContract?.mcpLifecycle!=="not-owned"||
     listeners.get(port)!==status.supervisorPid)
    throw new Error("GUARDIAN_STALE_CORE_UNVERIFIED");
  const checkpoint=readCoreCheckpoint(port);
  if(checkpoint.activePid!==status.active.pid||
     !checkpoint.workers.some(w=>w.pid===status.active.pid)||
     checkpoint.clientMode!=="tline")
    throw new Error("GUARDIAN_STALE_CORE_CHECKPOINT_UNVERIFIED");

  const ownerFile=managedGuardianOwnerPath(port),leaseFile=coreGuardianFile(port);
  const ownerRaw=safeRecord(ownerFile,2048),leaseRaw=safeRecord(leaseFile,1024);
  const owner=readManagedGuardianOwner(port),lease=readCoreGuardianLease(port);
  if(!owner||!lease||lease.ownership!=="spawned"&&lease.ownership!=="adopted"||
     !lease.supervisorPid)
    throw new Error("GUARDIAN_STALE_OWNER_RECORD_MISMATCH");
  const observed=await inspectManagedGuardian(port);
  // Both the managed owner and the independent Guardian lease can refer to
  // different generations. Both PIDs must be independently absent.
  const pids=[...new Set([owner.pid,lease.pid])];
  const absent=absentProcesses(pids);
  assertGuardianStaleRecoverySafety({
    coreSupervisorPid:status.supervisorPid,previousSupervisorPid:lease.supervisorPid,
    ownerPid:owner.pid,leasePid:lease.pid,ownerPresent:true,
    controlPortBound:listeners.has(owner.controlPort),
    oldPidPresent:!absent,verifiedGuardian:observed.verified,
  });
  return {port,coreSupervisorPid:status.supervisorPid,ownerPid:owner.pid,
    leasePid:lease.pid,previousSupervisorPid:lease.supervisorPid,
    controlPort:owner.controlPort,recordDigest:fingerprint(ownerRaw,leaseRaw)};
}

export async function planStaleManagedGuardianRecovery(port:number):Promise<Evidence>{
  return inspect(port);
}

/**
 * Requires an explicit plan digest, supervisor identity and operator review.
 * Archives evidence without deleting secrets or touching a running process.
 */
export async function recoverStaleManagedGuardian(input:{
  port:number;expectedDigest:string;expectedSupervisorPid:number;
  reviewed:boolean;
}):Promise<{archived:true;archiveDirectory:string;coreSupervisorPid:number}>{
  if(input.reviewed!==true||!/^[a-f0-9]{64}$/.test(input.expectedDigest))
    throw new Error("GUARDIAN_STALE_EXPLICIT_REVIEW_AND_PLAN_REQUIRED");
  const dir=getRootConfigDir(),stat=fs.lstatSync(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink())
    throw new Error("GUARDIAN_STALE_UNSAFE_DIRECTORY");
  const lock=path.join(dir,"guardian-stale-recovery-"+input.port+".lock");
  const fd=fs.openSync(lock,"wx",0o600);
  try{
    const before=await inspect(input.port);
    if(before.recordDigest!==input.expectedDigest||
       before.coreSupervisorPid!==input.expectedSupervisorPid)
      throw new Error("GUARDIAN_STALE_PLAN_CHANGED");
    const ownerFile=managedGuardianOwnerPath(input.port);
    const leaseFile=coreGuardianFile(input.port);
    // Revalidate both OS process identities immediately before the first move.
    if(!absentProcesses([...new Set([before.ownerPid,before.leasePid])]))
      throw new Error("GUARDIAN_STALE_PROCESS_REAPPEARED");
    const listeners=readListenerOwners();
    if(!listeners||listeners.has(before.controlPort)||
       listeners.get(input.port)!==before.coreSupervisorPid)
      throw new Error("GUARDIAN_STALE_LISTENER_CHANGED");
    const suffix=Date.now()+"-"+crypto.randomBytes(6).toString("hex");
    const archiveDirectory=path.join(dir,"guardian-stale-archive-"+input.port+"-"+suffix);
    fs.mkdirSync(archiveDirectory,{mode:0o700});
    const ownerDest=path.join(archiveDirectory,path.basename(ownerFile));
    const leaseDest=path.join(archiveDirectory,path.basename(leaseFile));
    // The exclusive recovery lock serializes manual recovery attempts. If
    // either move fails, retain evidence and leave the remaining file blocking start.
    if(fingerprint(safeRecord(ownerFile,2048),safeRecord(leaseFile,1024))!==before.recordDigest)
      throw new Error("GUARDIAN_STALE_RECORD_CHANGED");
    fs.renameSync(ownerFile,ownerDest);
    fs.renameSync(leaseFile,leaseDest);
    return {archived:true,archiveDirectory,coreSupervisorPid:before.coreSupervisorPid};
  }finally{
    fs.closeSync(fd);
    fs.rmSync(lock,{force:true});
  }
}
