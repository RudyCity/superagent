/**
 * Production runtime certificate.
 *
 * Expensive historical drills (rollback, bounded soak, installed T-Line E2E)
 * are persisted for a short validity window. Volatile security evidence is
 * never trusted from this file and is re-verified live by rollout-audit.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getMcpStateFile, readMcpStateFile } from "../mcp/mcpTunnel.js";
import { issuerOAuthStateDir } from "../mcp/mcpOAuthPersistentStore.js";
import { unprotectNewIssuerKey } from "../mcp/mcpWindowsDpapiKey.js";
import { auditCoreColdStart } from "./coreColdStartAudit.js";
import { readListenerOwners, readMcpStateInventory } from "./coreMcpOwnershipAudit.js";
import { readCoreGuardianLease } from "./coreGuardian.js";
import type { RuntimeOwnershipContract } from "./runtimeOwnershipContract.js";

const MAX_CERT_BYTES = 16 * 1024;
const MAX_CERT_AGE_MS = 7 * 24 * 60 * 60_000;

export interface RuntimeProductionCertificate {
  version: 1;
  corePort: number;
  issuedAt: number;
  validUntil: number;
  operatorApprovedAt: number;
  rollback: {
    passed: true; verifiedAt: number;
    beforeWorkerPid: number; restartWorkerPid: number; rollbackWorkerPid: number;
  };
  soak: {
    passed: true; verifiedAt: number; durationMs: number; restartCycles: number;
    mcpPidsStable: true; guardianStable: true;
  };
  tline: {
    passed: true; verifiedAt: number; version: string;
    verifyAllPassed: true; bundlePassed: true; guiSmokePassed: true;
  };
}

export interface LiveRuntimeSecurityEvidence {
  privateOAuthIssuerVerified: boolean;
  windowsKeystoreAndAclVerified: boolean;
  liveIssuerTlsVerified: boolean;
  separateIngressVerified: boolean;
  oauthClientsReauthorized: boolean;
  legacyMcpSessions: number | null;
  pendingExternalEffects: number | null;
  guardianVerified: boolean;
  reasons: string[];
}

export function runtimeProductionCertificatePath(corePort=7888): string {
  if (!Number.isInteger(corePort) || corePort < 1024 || corePort > 65535)
    throw new Error("Invalid production certificate port");
  return path.join(os.homedir(), ".superagent-r", "runtime-production-cert-" + corePort + ".json");
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function validTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function assertCertificate(value: unknown, corePort: number): RuntimeProductionCertificate {
  const v=value as Partial<RuntimeProductionCertificate>;
  const now=Date.now();
  if(v?.version!==1||v.corePort!==corePort||!validTime(v.issuedAt)||!validTime(v.validUntil)||
     !validTime(v.operatorApprovedAt)||v.validUntil!<=now||v.validUntil!-v.issuedAt!>MAX_CERT_AGE_MS||
     v.issuedAt!>now+60_000||
     v.rollback?.passed!==true||!validTime(v.rollback.verifiedAt)||
     !validPid(v.rollback.beforeWorkerPid)||!validPid(v.rollback.restartWorkerPid)||
     !validPid(v.rollback.rollbackWorkerPid)||
     v.soak?.passed!==true||!validTime(v.soak.verifiedAt)||
     !Number.isSafeInteger(v.soak.durationMs)||v.soak.durationMs!<30_000||
     !Number.isSafeInteger(v.soak.restartCycles)||v.soak.restartCycles!<2||
     v.soak.mcpPidsStable!==true||v.soak.guardianStable!==true||
     v.tline?.passed!==true||!validTime(v.tline.verifiedAt)||
     typeof v.tline.version!=="string"||v.tline.version.length<1||v.tline.version.length>64||
     v.tline.verifyAllPassed!==true||v.tline.bundlePassed!==true||v.tline.guiSmokePassed!==true)
    throw new Error("Invalid or expired production runtime certificate");
  return v as RuntimeProductionCertificate;
}

export function readRuntimeProductionCertificate(corePort=7888): RuntimeProductionCertificate|null {
  const file=runtimeProductionCertificatePath(corePort);
  try{
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<2||stat.size>MAX_CERT_BYTES)
      throw new Error("Unsafe production certificate file");
    return assertCertificate(JSON.parse(fs.readFileSync(file,"utf8")),corePort);
  }catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")return null;
    return null;
  }
}

export function writeRuntimeProductionCertificate(
  cert: RuntimeProductionCertificate,
): void {
  assertCertificate(cert,cert.corePort);
  const file=runtimeProductionCertificatePath(cert.corePort);
  const dir=path.dirname(file);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const tmp=file+"."+process.pid+"."+crypto.randomBytes(5).toString("hex")+".tmp";
  try{
    fs.writeFileSync(tmp,JSON.stringify(cert,null,2),{flag:"wx",mode:0o600});
    fs.renameSync(tmp,file);
  }finally{try{fs.rmSync(tmp,{force:true})}catch{}}
}

function safeJsonFile(file:string,max=12_000_000):unknown {
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<2||stat.size>max)
    throw new Error("Unsafe runtime security file");
  return JSON.parse(fs.readFileSync(file,"utf8"));
}

function verifyOAuthAcl(dir:string):boolean {
  if(process.platform!=="win32")return false;
  try{
    const script=[
      "$ErrorActionPreference='Stop'",
      "$p="+JSON.stringify(dir),
      "$acl=Get-Acl -LiteralPath $p",
      "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "$allowed=@($me,'S-1-5-18','S-1-5-32-544')",
      "$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])",
      "$bad=@($rules|Where-Object{$_.AccessControlType -eq 'Allow' -and $allowed -notcontains $_.IdentityReference.Value})",
      "$result=[pscustomobject]@{Protected=$acl.AreAccessRulesProtected;Bad=$bad.Count}",
      "$result|ConvertTo-Json -Compress",
    ].join(";");
    const raw=execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{
      encoding:"utf8",timeout:8000,maxBuffer:16_384,windowsHide:true,
    }).trim();
    const result=JSON.parse(raw) as {Protected?:boolean;Bad?:number};
    return result.Protected===true&&result.Bad===0;
  }catch{return false}
}

async function fetchIssuer(issuer:string):Promise<boolean> {
  try{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),6500);
    try{
      const response=await fetch(issuer+"/.well-known/oauth-authorization-server",{
        method:"GET",headers:{Accept:"application/json"},signal:controller.signal,
      });
      if(response.status!==200)return false;
      const body=await response.json() as Record<string,unknown>;
      const exact=typeof body.issuer==="string"&&body.issuer.replace(/\/$/,"")===issuer;
      const auth=typeof body.authorization_endpoint==="string"&&body.authorization_endpoint.startsWith(issuer+"/");
      const token=typeof body.token_endpoint==="string"&&body.token_endpoint.startsWith(issuer+"/");
      return exact&&auth&&token;
    }finally{clearTimeout(timer)}
  }catch{return false}
}

async function verifyIssuerStore(issuer:string):Promise<{
  tls:boolean;keystore:boolean;clients:boolean;
}> {
  const tls=await fetchIssuer(issuer);
  const dir=issuerOAuthStateDir(issuer);
  let keystore=false,clients=false;
  try{
    const protectedKey=path.join(dir,"oauth-state.key.dpapi");
    const rawKey=path.join(dir,"oauth-state.key");
    const stateFile=path.join(dir,"oauth-state.json");
    if(!fs.existsSync(protectedKey)||fs.existsSync(rawKey)||!fs.existsSync(stateFile))
      return {tls,keystore:false,clients:false};
    const key=unprotectNewIssuerKey(safeJsonFile(protectedKey,65536) as any);
    try{
      const envelope=safeJsonFile(stateFile) as any;
      const expected=crypto.createHmac("sha256",key).update(JSON.stringify(envelope.payload)).digest("hex");
      const integrity=envelope?.version===1&&typeof envelope.mac==="string"&&
        /^[a-f0-9]{64}$/.test(envelope.mac)&&
        crypto.timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(envelope.mac,"hex"))&&
        envelope.payload?.issuer===issuer;
      const now=Date.now();
      const clientCount=Array.isArray(envelope.payload?.clients)?envelope.payload.clients.length:0;
      const activeRefresh=Array.isArray(envelope.payload?.refresh)?
        envelope.payload.refresh.filter((x:any)=>!x.revoked&&Number(x.expiresAt)>now).length:0;
      clients=integrity&&clientCount>0&&activeRefresh>0;
      keystore=integrity&&verifyOAuthAcl(dir);
    }finally{key.fill(0)}
  }catch{}
  return {tls,keystore,clients};
}

export async function inspectLiveRuntimeSecurity(
  ownership: Pick<RuntimeOwnershipContract,"ownershipTopology"|"core"|"mcp">,
  corePort=7888,
):Promise<LiveRuntimeSecurityEvidence>{
  const reasons:string[]=[];
  const current=ownership.mcp.filter(m=>
    m.authMode==="oauth"&&m.state==="os_pid_correlated_only"&&
    m.authenticationVerified&&m.publicTunnelVerified&&m.oauthStatePersistent);
  const privateOAuthIssuerVerified=current.length>0&&current.length===ownership.mcp.length;
  if(!privateOAuthIssuerVerified)reasons.push("CURRENT_MCP_OWNER_NOT_FULLY_AUTHENTICATED");

  let liveIssuerTlsVerified=privateOAuthIssuerVerified;
  let windowsKeystoreAndAclVerified=privateOAuthIssuerVerified;
  let oauthClientsReauthorized=privateOAuthIssuerVerified;
  for(const m of current){
    const state=readMcpStateFile(getMcpStateFile(m.port));
    if(!state||state.pid!==m.recordedPid||!state.publicUrl){
      liveIssuerTlsVerified=false;windowsKeystoreAndAclVerified=false;oauthClientsReauthorized=false;
      reasons.push("MCP_STATE_MISSING_OR_PID_MISMATCH");continue;
    }
    let issuer="";
    try{issuer=(state.oauthPublicBaseUrl||new URL(state.publicUrl).origin).replace(/\/$/,"")}
    catch{reasons.push("MCP_PUBLIC_ISSUER_INVALID");liveIssuerTlsVerified=false;continue}
    const result=await verifyIssuerStore(issuer);
    if(!result.tls){liveIssuerTlsVerified=false;reasons.push("ISSUER_TLS_DISCOVERY_FAILED")}
    if(!result.keystore){windowsKeystoreAndAclVerified=false;reasons.push("DPAPI_HMAC_OR_ACL_FAILED")}
    if(!result.clients){oauthClientsReauthorized=false;reasons.push("NO_ACTIVE_DURABLE_OAUTH_CLIENT")}
  }

  const cold=await auditCoreColdStart(corePort);
  const pendingExternalEffects=cold.snapshot.ambiguousTurns===0&&
    cold.snapshot.sessionReceiptsReconciled===true&&cold.snapshot.externalEffectsReconciled===true?0:null;
  if(pendingExternalEffects!==0)reasons.push("PENDING_EFFECT_EVIDENCE_UNRESOLVED");

  let guardianVerified=false;
  try{
    const guardian=readCoreGuardianLease(corePort);
    const listeners=readListenerOwners();
    if(guardian&&listeners&&ownership.core.listenerPid!==null){
      let alive=false;try{process.kill(guardian.pid,0);alive=true}catch{}
      guardianVerified=alive&&
        (guardian.supervisorPid===undefined||guardian.supervisorPid===ownership.core.listenerPid);
    }
  }catch{}
  if(!guardianVerified)reasons.push("GUARDIAN_NOT_VERIFIED");

  const noShared=ownership.ownershipTopology!=="shared_owner_do_not_cutover"&&
    privateOAuthIssuerVerified;
  return {
    privateOAuthIssuerVerified,
    windowsKeystoreAndAclVerified,
    liveIssuerTlsVerified,
    separateIngressVerified:privateOAuthIssuerVerified,
    oauthClientsReauthorized,
    legacyMcpSessions:noShared?0:null,
    pendingExternalEffects,
    guardianVerified,
    reasons,
  };
}
