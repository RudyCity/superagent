/**
 * Read-only TCP ownership evidence for API Core and MCP listeners.
 * Does not authenticate OAuth, start/stop a process or claim PID ownership.
 * OS listener evidence is preferred over mutable MCP state files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getRootConfigDir } from "../config/paths.js";
import { auditCoreColdStart } from "./coreColdStartAudit.js";

export type ListenerEvidence = { port: number; pid: number | null; status: "listening"|"not_listening"|"unknown" };
export type McpProcessEvidence = {
  port: number; recordedPid: number;
  listenerPid: number|null;
  identity: "pid_verified"|"pid_mismatch"|"listener_absent"|"unverified";
  authMode: "oauth"|"static-bearer"|"unknown";
};
export type CoreMcpOwnershipAssessment = {
  version: 1; corePort: number; core: ListenerEvidence;
  coreRegistration: "supervised"|"legacy_or_foreign"|"absent"|"unverified";
  mcp: McpProcessEvidence[];
  decision: "shared_owner_do_not_cutover"|"unverified_do_not_cutover"|"separate_owners_needs_operator_review";
  canRestartCore: false; canStopMcp: false; canTransferOAuth: false;
  externalProcessSignalsSent: false;
};
function validPort(p:number):boolean {return Number.isInteger(p)&&p>=1024&&p<=65535;}
function parseNetstat(stdout:string):Map<number,number>{
  const map=new Map<number,number>();
  for(const line of stdout.split(/\r?\n/)){
    const c=line.trim().split(/\s+/);
    if(c.length<5||c[0].toUpperCase()!=="TCP"||c[3].toUpperCase()!=="LISTENING")continue;
    const local=c[1]||"";
    const match=local.match(/^(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)$/);
    if(!match)continue;
    const port=Number(match[1]),pid=Number(c[4]);
    if(validPort(port)&&Number.isSafeInteger(pid)&&pid>0){
      if(map.has(port)&&map.get(port)!==pid)map.set(port,0);
      else map.set(port,pid);
    }
  }
  return map;
}
export function readListenerOwners(): Map<number,number>|null {
  if(process.platform!=="win32")return null; // fail closed on unsupported OS
  try{
    const output=execFileSync("netstat.exe",["-ano","-p","TCP"],{
      encoding:"utf8",timeout:4000,maxBuffer:2*1024*1024,windowsHide:true,
    });
    return parseNetstat(output);
  }catch{return null;}
}
export function parseWindowsListenerOwners(text:string):Map<number,number>{
  return parseNetstat(text);
}
export interface McpRecordedProcess {
  port:number;pid:number;authMode:"oauth"|"static-bearer"|"unknown";
  /** True only when the active owner persisted issuer-scoped OAuth state. */
  oauthStatePersistent?: boolean;
}
export interface McpStateInventory {
  records:McpRecordedProcess[];
  rejected:number;
  directory:"present"|"absent"|"unverified";
}
/** Discover MCP state files without suppressing corrupt or untrusted entries.
 * Do not output their paths or any public URL/credentials in the report.
 */
export function readMcpStateInventory(dir=path.join(os.homedir(),".superagent-r")):McpStateInventory {
  // MCP state files intentionally live in the shared real-user directory,
  // not in transient supervised worker profiles. Only read them; no cleanup.
  let entries:string[];
  try {
    const stat=fs.lstatSync(dir);
    if(!stat.isDirectory() || stat.isSymbolicLink())
      return {records:[],rejected:1,directory:"unverified"};
    entries=fs.readdirSync(dir);
  } catch(e) {
    if((e as NodeJS.ErrnoException).code==="ENOENT")
      return {records:[],rejected:0,directory:"absent"};
    return {records:[],rejected:1,directory:"unverified"};
  }
  const matching=entries.filter(n=>/^mcp-\d{4,5}\.json$/.test(n));
  if(matching.length>256)throw new Error("Too many MCP state files to audit safely");
  const records:McpRecordedProcess[]=[];
  let rejected=0;
  for(const name of entries){
    // mcp-tool-exposure.json and other named config files are NOT server
    // registrations. Only numeric-looking state records are candidates.
    if(!/^mcp-\d/i.test(name))continue;
    if(!/^mcp-\d{4,5}\.json$/.test(name)) {rejected++;continue;}
    try{
      const f=path.join(dir,name),stat=fs.lstatSync(f);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>16*1024) {rejected++;continue;}
      const state=JSON.parse(fs.readFileSync(f,"utf8")) as Record<string,unknown>;
      const port=Number(name.slice(4,-5));
      if(!validPort(port)||state.port!==port||
         !Number.isSafeInteger(state.pid)||Number(state.pid)<=0) {rejected++;continue;}
      records.push({port,pid:Number(state.pid),authMode:state.authMode==="oauth"?"oauth":
        state.authMode==="static-bearer"?"static-bearer":"unknown",
        ...(state.oauthStatePersistent===true?{oauthStatePersistent:true}:{}),
      });
    }catch{rejected++;}
  }
  return {records:records.sort((a,b)=>a.port-b.port),rejected,directory:"present"};
}
export async function auditCoreMcpOwnership(input:{
  corePort?:number; listeners?:Map<number,number>|null;
  mcps?:Array<{port:number;pid:number;authMode:"oauth"|"static-bearer"|"unknown"}>;
  coreRegistration?:CoreMcpOwnershipAssessment["coreRegistration"];
}={}):Promise<CoreMcpOwnershipAssessment>{
  const corePort=input.corePort??7888;
  if(!validPort(corePort))throw new Error("Invalid API port");
  const listeners=input.listeners===undefined?readListenerOwners():input.listeners;
  const owner=listeners?.get(corePort);
  const core:ListenerEvidence={
    port:corePort,pid:owner&&owner>0?owner:null,
    status:!listeners?"unknown":owner===undefined?"not_listening":owner>0?"listening":"unknown",
  };
  let registration=input.coreRegistration;
  if(!registration) {
    try{
      const audit=await auditCoreColdStart(corePort);
      registration=audit.snapshot.ownerOnline?"supervised":
        audit.snapshot.foreignListenerDetected?"legacy_or_foreign":
        core.status==="not_listening"?"absent":"unverified";
    }catch{registration="unverified";}
  }
  const entries=input.mcps??readMcpStateInventory().records;
  const mcp=entries.map(s=>{
    const pid=listeners?.get(s.port);
    const identity:McpProcessEvidence["identity"]=!listeners?"unverified":
      pid===undefined?"listener_absent":pid===s.pid?"pid_verified":
      pid>0?"pid_mismatch":"unverified";
    return {port:s.port,recordedPid:s.pid,listenerPid:pid&&pid>0?pid:null,
      identity,authMode:s.authMode};
  });
  const shared=core.pid!==null && mcp.some(m=>m.listenerPid===core.pid&&m.identity==="pid_verified");
  const complete=core.status==="listening"&&registration==="supervised"&&
    mcp.length>0&&mcp.every(m=>m.identity==="pid_verified")&&!shared;
  return {version:1,corePort,core,coreRegistration:registration,mcp,
    decision:shared?"shared_owner_do_not_cutover":
      complete?"separate_owners_needs_operator_review":"unverified_do_not_cutover",
    canRestartCore:false,canStopMcp:false,canTransferOAuth:false,
    externalProcessSignalsSent:false};
}
