/**
 * R0 Runtime Ownership Contract v1.
 *
 * An inventory of evidence, NEVER a process-control capability. In particular
 * a listening PID or saved state is NOT authorization to stop a process, rebind
 * a port, reuse an OAuth issuer or replay any MCP tool call.
 */
import { readListenerOwners, readMcpStateInventory, auditCoreMcpOwnership,
  type McpRecordedProcess, type McpStateInventory,
  type CoreMcpOwnershipAssessment } from "./coreMcpOwnershipAudit.js";
import { requestCoreSupervisor } from "./coreSupervisor.js";

export interface AuthenticatedCoreObservation {
  publicPort: number;
  supervisorPid: number;
  activePid: number;
}
export interface RuntimeOwnershipEvidence {
  corePort: number;
  listenerBefore: Map<number,number>|null;
  listenerAfter: Map<number,number>|null;
  stateInventory: McpStateInventory;
  authenticatedCore: AuthenticatedCoreObservation|null;
}
export interface RuntimeOwnershipContract {
  schemaVersion: 1;
  mode: "read_only_inventory";
  core: {
    port:number; listenerPid:number|null;
    state:"absent"|"verified_supervisor"|"unverified"|"identity_mismatch";
    authenticatedSupervisorPid:number|null;
  };
  mcp: Array<{
    port:number; recordedPid:number; listenerPid:number|null;
    state:"os_pid_correlated_only"|"stale_state"|"unknown";
    authMode:"oauth"|"static-bearer"|"unknown";
    authenticationVerified:false;
    sessionsDrainVerified:false;
  }>;
  stateFiles: {directory:McpStateInventory["directory"]; rejected:number};
  ownershipTopology: CoreMcpOwnershipAssessment["decision"];
  blockers:string[];
  listenerSamplesStable:boolean;
  canRestartCore:false;
  canStopMcp:false;
  canTransferOAuth:false;
  canMigrateSessions:false;
  automaticToolReplayAllowed:false;
  signalsSent:false;
  filesChanged:false;
  nextAction:"OPERATOR_REVIEW_ONLY";
}
function knownPid(p:number|undefined):number|null{
  return typeof p==="number" && Number.isSafeInteger(p) && p>0 ? p : null;
}
function pidAt(m:Map<number,number>|null,p:number):number|null{
  return m===null?null:knownPid(m.get(p));
}
function equalPortEvidence(a:Map<number,number>|null,b:Map<number,number>|null,ports:number[]):boolean {
  if(!a||!b)return false;
  return ports.every(p=>a.get(p)===b.get(p));
}
export async function assessRuntimeOwnership(e:RuntimeOwnershipEvidence):Promise<RuntimeOwnershipContract>{
  if(!Number.isInteger(e.corePort)||e.corePort<1024||e.corePort>65535)
    throw new Error("Invalid Core port");
  if(!["present","absent","unverified"].includes(e.stateInventory.directory)||
    !Number.isInteger(e.stateInventory.rejected)||e.stateInventory.rejected<0||
    e.stateInventory.records.length>256)throw new Error("Invalid MCP state inventory");
  const seen=new Set<number>([e.corePort]);
  for(const state of e.stateInventory.records) {
    if(!Number.isInteger(state.port)||state.port<1024||state.port>65535||
      !Number.isSafeInteger(state.pid)||state.pid<1||seen.has(state.port))
      throw new Error("Duplicate or malformed MCP owner evidence");
    seen.add(state.port);
  }
  const stable=equalPortEvidence(e.listenerBefore,e.listenerAfter,[...seen]);
  const osCore=pidAt(e.listenerAfter,e.corePort);
  const recorded=e.authenticatedCore;
  const authenticated=recorded!==null &&
    recorded.publicPort===e.corePort &&
    Number.isSafeInteger(recorded.supervisorPid) && recorded.supervisorPid>0 &&
    Number.isSafeInteger(recorded.activePid) && recorded.activePid>0;
  const matches=authenticated && stable && osCore===recorded!.supervisorPid;
  const coreState:RuntimeOwnershipContract["core"]["state"]=
    !stable?"unverified":
    osCore===null?(e.listenerAfter?.has(e.corePort)?"unverified":"absent"):
    matches?"verified_supervisor":authenticated?"identity_mismatch":"unverified";
  const classification=await auditCoreMcpOwnership({
    corePort:e.corePort,
    listeners:e.listenerAfter,
    mcps:e.stateInventory.records,
    coreRegistration:coreState==="verified_supervisor"?"supervised":
      coreState==="absent"?"absent":"unverified",
  });
  const mcp=e.stateInventory.records.map(s=>{
    const osPid=pidAt(e.listenerAfter,s.port);
    return {port:s.port,recordedPid:s.pid,listenerPid:osPid,
      state:(!stable||e.listenerAfter===null)?"unknown" as const:
        osPid===s.pid?"os_pid_correlated_only" as const:"stale_state" as const,
      authMode:s.authMode,authenticationVerified:false as const,
      sessionsDrainVerified:false as const};
  });
  const blockers:string[]=[];
  if(!stable)blockers.push("KERNEL_LISTENER_EVIDENCE_UNSTABLE_OR_UNAVAILABLE");
  if(e.stateInventory.directory==="unverified"||e.stateInventory.rejected>0)
    blockers.push("MCP_STATE_FILES_MALFORMED_OR_UNREADABLE");
  if(e.stateInventory.directory==="absent"||mcp.length===0)
    blockers.push("NO_AUTHENTICATED_MCP_OWNER_INVENTORY");
  if(coreState==="identity_mismatch")blockers.push("CORE_SUPERVISOR_PID_MISMATCH");
  if(coreState==="unverified")blockers.push("CORE_OWNER_NOT_AUTHENTICATED");
  if(mcp.some(x=>x.state!=="os_pid_correlated_only"))
    blockers.push("MCP_OS_LISTENER_NOT_MATCHED_TO_STATE");
  // Block on actual kernel PID-sharing even if an MCP state file is stale.
  if(osCore!==null&&mcp.some(x=>x.listenerPid===osCore))blockers.push("CORE_AND_MCP_SHARE_KERNEL_PID");
  blockers.push("MCP_OAUTH_AND_DRAIN_STATE_NOT_AUTHENTICATED");
  blockers.push("NO_PRODUCTION_CUTOVER_AUTHORIZATION");
  return {schemaVersion:1,mode:"read_only_inventory",
    core:{port:e.corePort,listenerPid:osCore,state:coreState,
      authenticatedSupervisorPid:authenticated?recorded!.supervisorPid:null},
    mcp,stateFiles:{directory:e.stateInventory.directory,rejected:e.stateInventory.rejected},
    ownershipTopology:classification.decision,
    blockers,listenerSamplesStable:stable,
    canRestartCore:false,canStopMcp:false,canTransferOAuth:false,
    canMigrateSessions:false,automaticToolReplayAllowed:false,
    signalsSent:false,filesChanged:false,nextAction:"OPERATOR_REVIEW_ONLY"};
}
export async function captureRuntimeOwnership(corePort=7888, sources?:{
  listenerOwners?:()=>Map<number,number>|null;
  mcpInventory?:()=>McpStateInventory;
  authenticatedCore?:()=>Promise<AuthenticatedCoreObservation|null>;
}):Promise<RuntimeOwnershipContract>{
  const listenerOwners=sources?.listenerOwners??readListenerOwners;
  const mcpInventory=sources?.mcpInventory??readMcpStateInventory;
  const readCore=sources?.authenticatedCore??(async()=>{
    try {
      const s=await requestCoreSupervisor("status",corePort,1200);
      return {publicPort:s.publicPort,supervisorPid:s.supervisorPid,activePid:s.active.pid};
    }catch{return null;}
  });
  // No snapshots, PID signals, token reads in output or mutations. Sample both
  // sides of the authenticated control probe to catch an owner replacement.
  const before=listenerOwners();
  const inventory=mcpInventory();
  let core:AuthenticatedCoreObservation|null=null;
  try{core=await readCore();}catch{}
  const after=listenerOwners();
  return await assessRuntimeOwnership({
    corePort,listenerBefore:before,listenerAfter:after,
    stateInventory:inventory,authenticatedCore:core,
  });
}
