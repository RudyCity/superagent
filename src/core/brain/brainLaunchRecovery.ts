/**
 * Evidence-bound Brain launch recovery.
 *
 * An acknowledgement timeout must never be interpreted as "job did not start".
 * A task reservation stores a Bridge idempotency key before dispatch. Operators
 * may attach ONLY the persisted Bridge job bearing that exact key AND task cwd.
 * No operation here launches, kills, or unconditionally unlocks a process.
 */
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { inspectBrainSession } from "./brainWorkspace.js";
import { assertNoSymlink } from "./brainStorageManager.js";
import { inspectBrainTask, recordBrainTaskDelegation, updateBrainTask, finishBrainTaskLaunch } from "./brainTasks.js";

const TASK=/^task_[a-f0-9]{20}$/;
const JOB=/^clj_\d+_[a-f0-9]{8,32}$/;
const SNAPSHOT=/^\d{13}-\d{10}-[a-f0-9]{16}\.json$/;
type Reservation={agentId:string;token:string;createdAt:number;idempotencyKey?:string};
type Match={jobId:string;cli:string;status:string;completionState:string;updatedAt:number};
const canon=(p:string)=>process.platform==="win32"?p.toLowerCase():p;
function sessionPaths(owner:string,sessionId:string,taskId:string,root:string){
 if(!TASK.test(taskId))throw new Error("Invalid Brain task ID");
 const dir=inspectBrainSession(owner,sessionId,root).path;
 const file=path.join(dir,".tasks",taskId+".launch.json");
 assertNoSymlink(dir,file);
 return {dir,file};
}
function readReservation(file:string):Reservation|null {
 if(!fs.existsSync(file))return null;
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>2048)throw new Error("Unsafe Brain launch reservation");
 const item=JSON.parse(fs.readFileSync(file,"utf8")) as Reservation;
 if(!item||typeof item.agentId!=="string"||!/^[a-zA-Z][\w-]{0,47}$/.test(item.agentId)||
    typeof item.token!=="string"||!/^[a-f0-9]{32}$/.test(item.token)||
    !Number.isSafeInteger(item.createdAt)||item.createdAt<=0)throw new Error("Invalid Brain launch reservation");
 return item;
}
function matchingJobs(root:string,cwd:string,key:string):Match[] {
 const folder=path.join(root,"cli-bridge","delegations","jobs.d");
 assertNoSymlink(root,folder);
 if(!fs.existsSync(folder))return [];
 const entries=fs.readdirSync(folder,{withFileTypes:true});
 if(entries.length>5000)throw new Error("CLI Bridge job index too large; operator review required");
 const matches:Match[]=[];
 for(const entry of entries) {
  if(!entry.isDirectory()||!JOB.test(entry.name))continue;
  const shard=path.join(folder,entry.name);
  assertNoSymlink(folder,shard);
  const snapshots=fs.readdirSync(shard).filter(x=>SNAPSHOT.test(x)).sort().reverse().slice(0,8);
  for(const snapshot of snapshots) {
   const file=path.join(shard,snapshot);assertNoSymlink(folder,file);
   const stat=fs.lstatSync(file);
   if(!stat.isFile()||stat.nlink!==1||stat.size>65536)throw new Error("Unsafe Bridge snapshot; operator review required");
   let data:Record<string,unknown>;
   try {data=JSON.parse(fs.readFileSync(file,"utf8"));}catch {continue;}
   if(data.jobId!==entry.name||typeof data.cwd!=="string"||typeof data.status!=="string")continue;
   if(data.idempotencyKey!==key)break;
   if(!fs.existsSync(data.cwd))throw new Error("Bridge job cwd missing; operator review required");
   assertNoSymlink(path.dirname(cwd),data.cwd);
   if(canon(fs.realpathSync.native(data.cwd))!==canon(fs.realpathSync.native(cwd)))
     throw new Error("Bridge idempotency key belongs to another directory");
   matches.push({jobId:entry.name,cli:typeof data.cliAlias==="string"?data.cliAlias:"unknown",
    status:data.status,completionState:typeof data.completionState==="string"?data.completionState:"unknown",
    updatedAt:Number(data.updatedAt)||0});
   break;
  }
 }
 return matches;
}
export function inspectBrainTaskLaunch(owner:string,sessionId:string,taskId:string,root=getRootConfigDir()){
 const {dir,file}=sessionPaths(owner,sessionId,taskId,root);
 const task=inspectBrainTask(owner,sessionId,taskId,root);
 const reservation=readReservation(file);
 if(!reservation)return {taskId,state:"clear",matches:[] as Match[],reviewRequired:false};
 const cwd=path.join(dir,"scratch","agents",reservation.agentId,taskId);
 if(!fs.existsSync(cwd))throw new Error("Task scratch unavailable; operator review required");
 assertNoSymlink(dir,cwd);
 if(!task.agents.includes(reservation.agentId))throw new Error("Reservation agent not a task member");
 // Prior Phase 7 reservations had no Bridge dispatch key and cannot safely
 // be matched. Never auto-remove an ambiguous legacy reservation.
 const key="brain:"+taskId+":"+reservation.token;
 if(reservation.idempotencyKey&&reservation.idempotencyKey!==key)
   throw new Error("Reservation idempotency key mismatch");
 if(!reservation.idempotencyKey)return {taskId,agentId:reservation.agentId,
   state:"legacy-unknown",reviewRequired:true,matches:[] as Match[],createdAt:reservation.createdAt};
 const matches=matchingJobs(root,cwd,key);
 const recorded=task.delegationJobs??[];
 const state=matches.length>1?"conflicting-jobs":matches.length===0?"missing-evidence":
  recorded.some(x=>x.jobId===matches[0].jobId)?"already-recorded":"verified-match";
 return {taskId,agentId:reservation.agentId,state,reviewRequired:state!=="already-recorded",
  createdAt:reservation.createdAt,matches};
}
export function recoverBrainTaskLaunch(owner:string,sessionId:string,taskId:string,
 jobId:string,confirm:boolean,root=getRootConfigDir()) {
 if(confirm!==true||!JOB.test(jobId))throw new Error("Explicit operator confirmation and job ID required");
 const inspection=inspectBrainTaskLaunch(owner,sessionId,taskId,root);
 if(inspection.state!=="verified-match"&&inspection.state!=="already-recorded")
  throw new Error("No uniquely evidenced CLI Bridge job; reservation must remain for manual review");
 if(inspection.matches.length!==1||inspection.matches[0].jobId!==jobId)
  throw new Error("Bridge job ID does not match reservation evidence");
 const {dir,file}=sessionPaths(owner,sessionId,taskId,root);
 const record=readReservation(file);
 if(!record||record.agentId!==inspection.agentId||record.idempotencyKey!=="brain:"+taskId+":"+record.token)
  throw new Error("Launch reservation changed; inspect again");
 const task=inspectBrainTask(owner,sessionId,taskId,root);
 const match=inspection.matches[0];
 if(task.assignedTo!==record.agentId||["completed","cancelled"].includes(task.status))
  throw new Error("Task ownership changed; cannot safely attach");
 if(!["agy","claude","codex"].includes(match.cli))throw new Error("Unrecognized CLI for recovery");
 // Blocked retries must re-enter running before the acknowledged launch can
 // be registered. No further CLI process is dispatched.
 if(task.status==="blocked")updateBrainTask(owner,sessionId,taskId,record.agentId,"running",root);
 if(inspection.state==="verified-match")
  recordBrainTaskDelegation(owner,sessionId,taskId,record.agentId,match.cli,jobId,root);
 finishBrainTaskLaunch(owner,sessionId,taskId,record.agentId,record.token,jobId,root);
 const audit=path.join(dir,".tasks","launch-recovery-audit.jsonl");
 assertNoSymlink(dir,audit);
 if(fs.existsSync(audit)&&fs.statSync(audit).size>1024*1024)
  throw new Error("Recovery completed but audit requires maintenance");
 fs.appendFileSync(audit,JSON.stringify({at:new Date().toISOString(),taskId,jobId,
  action:"evidence-attach",result:"attached"})+"\n",{mode:0o600});
 return {taskId,jobId,status:match.status,recovered:true,retryDispatched:false};
}
