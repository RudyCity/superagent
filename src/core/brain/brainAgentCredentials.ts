/**
 * Owner-scoped, short-lived Brain task agent capabilities.
 * Caller receives plaintext only on issue/rotation. Disk stores hashes only.
 * MCP remote rotations/revocations require proof of the CURRENT credential;
 * trusted local operator routes may explicitly administer credentials.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inspectBrainSession } from "./brainWorkspace.js";
import { inspectBrainTask } from "./brainTasks.js";
import { assertNoSymlink } from "./brainStorageManager.js";
import { withBrainSessionLock } from "./brainSessionLock.js";
const TASK = /^task_[a-f0-9]{20}$/;
const TOKEN = /^bag_[a-f0-9]{64}$/;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 7 * DEFAULT_TTL_MS;
type StoredAgent = { hash: string; issuedAt: number; expiresAt: number; revokedAt?: number; generation: number };
type CredentialAudit = {at:number;action:string;agentId:string;generation:number};
type RecordV2 = { schemaVersion: 2; agents: Record<string,StoredAgent>; updatedAt: number; ownerRecoveryHash?:string; audit?:CredentialAudit[] };
function appendAudit(data:RecordV2,action:string,agentId:string,generation:number,at=Date.now()){
 data.audit=[...(data.audit||[]).slice(-63),{at,action,agentId,generation}];
}
export function brainTaskCredentialAudit(owner:string,sessionId:string,taskId:string,configRoot?:string){
 const {file}=location(owner,sessionId,taskId,configRoot);
 return (read(file).audit||[]).map(entry=>({...entry,at:new Date(entry.at).toISOString()}));
}
type RecordV1 = { schemaVersion: 1; agentHashes: Record<string,string>; createdAt: string };
function location(owner:string,sessionId:string,taskId:string,configRoot?:string) {
  if(!TASK.test(taskId))throw new Error("Invalid Brain task.");
  const dir=inspectBrainSession(owner,sessionId,configRoot).path;
  const file=path.join(dir,".tasks",taskId+".capabilities.json");
  assertNoSymlink(dir,file);
  return {dir,file};
}
function newToken(){return "bag_"+crypto.randomBytes(32).toString("hex");}
function sha(value:string){return crypto.createHash("sha256").update(value).digest("hex");}
function ttl(value:number){if(!Number.isSafeInteger(value)||value<60000||value>MAX_TTL_MS)throw new Error("Invalid agent credential TTL.");return value;}
function read(file:string):RecordV2{
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>12000)throw new Error("Unsafe Brain capability store.");
  const raw=JSON.parse(fs.readFileSync(file,"utf8")) as RecordV1|RecordV2;
  if(raw.schemaVersion===2){
    if(!raw.agents||typeof raw.agents!=="object"||Array.isArray(raw.agents))throw new Error("Invalid capability record.");
    return raw;
  }
  if(raw.schemaVersion===1){
    // Legacy records are migrated on the next rotation or revoke. Their
    // finite expiration is based on the original creation timestamp.
    const at=Date.parse(raw.createdAt);
    if(!Number.isFinite(at)||!raw.agentHashes||typeof raw.agentHashes!=="object")throw new Error("Invalid legacy capability.");
    const agents:Record<string,StoredAgent>={};
    for(const [agent,hash] of Object.entries(raw.agentHashes)){
      if(!/^[a-f0-9]{64}$/.test(hash))throw new Error("Invalid legacy credential hash.");
      agents[agent]={hash,issuedAt:at,expiresAt:at+DEFAULT_TTL_MS,generation:1};
    }
    return {schemaVersion:2,agents,updatedAt:at};
  }
  throw new Error("Unrecognized credential store.");
}
function persist(file:string,record:RecordV2){
  const tmp=file+"."+crypto.randomBytes(8).toString("hex")+".tmp";
  try {fs.writeFileSync(tmp,JSON.stringify(record),{flag:"wx",mode:0o600});fs.renameSync(tmp,file);}
  finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
export function issueBrainTaskAgentCredentials(owner:string,sessionId:string,taskId:string,ttlMs=DEFAULT_TTL_MS,configRoot?:string){
  const duration=ttl(ttlMs),{dir,file}=location(owner,sessionId,taskId,configRoot);
  return withBrainSessionLock(dir,()=>{
    const task=inspectBrainTask(owner,sessionId,taskId,configRoot);
    const issuedAt=Date.now(),tokens:Record<string,string>={},agents:Record<string,StoredAgent>={};
    for(const agent of task.agents){
      const token=newToken();tokens[agent]=token;
      agents[agent]={hash:sha(token),issuedAt,expiresAt:issuedAt+duration,generation:1};
    }
    fs.writeFileSync(file,JSON.stringify({schemaVersion:2,agents,updatedAt:issuedAt,
      audit:task.agents.map(agentId=>({at:issuedAt,action:"issued",agentId,generation:1}))}),{flag:"wx",mode:0o600});
    return tokens;
  });
}
/** Issue once to the owner during task creation, NEVER to delegated agents.
 * A recovery secret is independent of agent expiry and rotated on every use.
 */
export function issueBrainTaskRecoveryCredential(owner:string,sessionId:string,taskId:string,configRoot?:string){
 const {dir,file}=location(owner,sessionId,taskId,configRoot);
 return withBrainSessionLock(dir,()=>{
  const data=read(file);
  if(data.ownerRecoveryHash)throw new Error("Owner recovery credential has already been issued.");
  const token=newToken();data.ownerRecoveryHash=sha(token);
  data.updatedAt=Date.now();appendAudit(data,"owner-recovery-issued","owner",1,data.updatedAt);persist(file,data);
  return token;
 });
}
export function authorizeBrainTaskOwnerRecovery(owner:string,sessionId:string,taskId:string,
 token:unknown,configRoot?:string){
 const {file}=location(owner,sessionId,taskId,configRoot);
 const record=read(file);
 if(typeof token!=="string"||!TOKEN.test(token)||!record.ownerRecoveryHash||
    !crypto.timingSafeEqual(Buffer.from(sha(token),"hex"),Buffer.from(record.ownerRecoveryHash,"hex")))
   throw new Error("Valid owner recovery credential required.");
 return true;
}
/** Recover an expired or revoked agent without trusting that agent's old token.
 * Requires a *different* owner-held one-time recovery secret. Old recovery
 * secret is invalidated alongside the recovered agent credential.
 */
export function recoverBrainTaskAgentCredential(owner:string,sessionId:string,taskId:string,
 agentId:string,recoveryCredential:unknown,configRoot?:string){
 const {dir,file}=location(owner,sessionId,taskId,configRoot);
 return withBrainSessionLock(dir,()=>{
  const data=read(file),existing=data.agents[agentId];
  if(!existing)throw new Error("Agent is not a member of this Brain task.");
  if(typeof recoveryCredential!=="string"||!TOKEN.test(recoveryCredential)||
    !data.ownerRecoveryHash||!/^[a-f0-9]{64}$/.test(data.ownerRecoveryHash)||
    !crypto.timingSafeEqual(Buffer.from(sha(recoveryCredential),"hex"),Buffer.from(data.ownerRecoveryHash,"hex")))
    throw new Error("Valid owner recovery credential required.");
  const token=newToken(),nextRecoveryCredential=newToken(),now=Date.now();
  data.agents[agentId]={hash:sha(token),issuedAt:now,expiresAt:now+DEFAULT_TTL_MS,
    generation:existing.generation+1};
  data.ownerRecoveryHash=sha(nextRecoveryCredential);data.updatedAt=now;
  appendAudit(data,"owner-recovered",agentId,existing.generation+1,now);
  persist(file,data);
  return {agentId,agentCredential:token,ownerRecoveryCredential:nextRecoveryCredential,
    expiresAt:new Date(now+DEFAULT_TTL_MS).toISOString(),generation:existing.generation+1};
 });
}
function requireValid(agentId:string,token:unknown,record:RecordV2):StoredAgent {
  if(typeof agentId!=="string"||typeof token!=="string"||!TOKEN.test(token))throw new Error("Brain task agent capability is required.");
  const agent=record.agents[agentId];
  if(!agent||!/^[a-f0-9]{64}$/.test(agent.hash))throw new Error("Brain task agent is not authorized.");
  if(agent.revokedAt)throw new Error("Brain task agent capability revoked.");
  if(!Number.isSafeInteger(agent.expiresAt)||Date.now()>=agent.expiresAt)throw new Error("Brain task agent capability expired.");
  if(!crypto.timingSafeEqual(Buffer.from(sha(token),"hex"),Buffer.from(agent.hash,"hex")))throw new Error("Brain task agent capability mismatch.");
  return agent;
}
export function authorizeBrainTaskAgent(owner:string,sessionId:string,taskId:string,agentId:string,token:unknown,configRoot?:string){
  const {file}=location(owner,sessionId,taskId,configRoot);
  if(!fs.existsSync(file))throw new Error("Brain task has no MCP agent capabilities; use local operator controls.");
  requireValid(agentId,token,read(file));return true;
}
export function brainTaskCapabilityStatus(owner:string,sessionId:string,taskId:string,configRoot?:string){
  const {file}=location(owner,sessionId,taskId,configRoot);
  const record=read(file);
  return Object.entries(record.agents).map(([agentId,value])=>({
    agentId,expiresAt:new Date(value.expiresAt).toISOString(),
    generation:value.generation,revoked:!!value.revokedAt,expired:Date.now()>=value.expiresAt,
  }));
}
export function rotateBrainTaskAgentCredential(
 owner:string,sessionId:string,taskId:string,agentId:string,
 options:{currentCredential?:string;operatorApproved?:boolean;ttlMs?:number}={},configRoot?:string,
){
  const {dir,file}=location(owner,sessionId,taskId,configRoot),duration=ttl(options.ttlMs??DEFAULT_TTL_MS);
  return withBrainSessionLock(dir,()=>{
    const data=read(file),existing=data.agents[agentId];
    if(!existing)throw new Error("Agent is not a member of this Brain task.");
    if(!options.operatorApproved)requireValid(agentId,options.currentCredential,data);
    const token=newToken(),now=Date.now();
    data.agents[agentId]={hash:sha(token),issuedAt:now,expiresAt:now+duration,generation:existing.generation+1};
    data.updatedAt=now;appendAudit(data,"rotated",agentId,existing.generation+1,now);persist(file,data);
    return {agentId,agentCredential:token,expiresAt:new Date(now+duration).toISOString(),generation:data.agents[agentId].generation};
  });
}
export function revokeBrainTaskAgentCredential(
 owner:string,sessionId:string,taskId:string,agentId:string,
 options:{currentCredential?:string;operatorApproved?:boolean}={},configRoot?:string,
){
  const {dir,file}=location(owner,sessionId,taskId,configRoot);
  return withBrainSessionLock(dir,()=>{
    const data=read(file),existing=data.agents[agentId];
    if(!existing)throw new Error("Agent is not a member of this Brain task.");
    if(!options.operatorApproved)requireValid(agentId,options.currentCredential,data);
    existing.revokedAt=Date.now();data.updatedAt=existing.revokedAt;
    appendAudit(data,"revoked",agentId,existing.generation,data.updatedAt);persist(file,data);
    return {agentId,revoked:true};
  });
}
