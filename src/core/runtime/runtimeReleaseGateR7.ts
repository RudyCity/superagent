/**
 * R6/R7 release/cutover gate. This report cannot commit a routing mutation.
 * It will never treat a scoped staging success as live client migration.
 */
import {assessMcpOAuthMigration} from "./mcpOAuthMigrationPolicy.js";
import type {RuntimeOwnershipContract} from "./runtimeOwnershipContract.js";
import {captureRuntimeOwnership} from "./runtimeOwnershipContract.js";
export interface RuntimeRolloutEvidence {
  topology:Pick<RuntimeOwnershipContract,
    "ownershipTopology"|"core"|"mcp">;
  privateOAuthIssuerVerified:boolean;
  windowsKeystoreAndAclVerified:boolean;
  liveIssuerTlsVerified:boolean;
  separateIngressVerified:boolean;
  desktopNativeE2EVerified:boolean;
  extendedSoakVerified:boolean;
  oauthClientsReauthorized:boolean;
  legacyMcpSessions:number|null;
  pendingExternalEffects:number|null;
  reversibleClientRoutingVerified:boolean;
  operatorApprovalForLiveCutover:boolean;
}
export interface RuntimeRolloutDecision {
 version:1;phase:"R6_R7_release_gate";
 status:"blocked"|"manual_cutover_review_candidate";
 blockers:string[];
 decisions:{
   oauthTokenImportAllowed:false;
   automaticLiveCutoverAllowed:false;
   canStopSharedCorePid:false;
   canReplayUnknownToolEffects:false;
 };
}
export function assessRuntimeRollout(e:RuntimeRolloutEvidence):RuntimeRolloutDecision{
  const oauth=assessMcpOAuthMigration({
    sharedLegacyCoreOwner:e.topology.ownershipTopology==="shared_owner_do_not_cutover",
    // Process/owner authentication is independent from the stronger OS
    // keystore+ACL release certification. Report them as separate gates.
    independentOwnerVerified:e.privateOAuthIssuerVerified,
    newIssuerConfigured:e.liveIssuerTlsVerified,
    publicMcpEndpointMatched:e.separateIngressVerified,
    clientsReauthorized:e.oauthClientsReauthorized,
    activeLegacySessions:e.legacyMcpSessions,
    pendingToolEffects:e.pendingExternalEffects,
    rollbackPathVerified:e.reversibleClientRoutingVerified,
    operatorApproved:e.operatorApprovalForLiveCutover,
  });
  const blockers=[...oauth.blockers];
  if(!e.windowsKeystoreAndAclVerified)blockers.push("OS_KEYSTORE_AND_ACL_NOT_CERTIFIED");
  if(!e.desktopNativeE2EVerified)blockers.push("INSTALLED_TLINE_E2E_NOT_CERTIFIED");
  if(!e.extendedSoakVerified)blockers.push("EXTENDED_SOAK_NOT_CERTIFIED");
  if(e.topology.core.state!=="verified_supervisor")
    blockers.push("CORE_SUPERVISOR_IDENTITY_NOT_VERIFIED");
  if(e.topology.mcp.some(m=>!m.authenticationVerified||!m.sessionsDrainVerified))
    blockers.push("MCP_AUTHENTICATION_OR_DRAIN_NOT_VERIFIED");
  return {version:1,phase:"R6_R7_release_gate",
    status:blockers.length?"blocked":"manual_cutover_review_candidate",
    blockers:[...new Set(blockers)],
    decisions:{
      oauthTokenImportAllowed:false,automaticLiveCutoverAllowed:false,
      canStopSharedCorePid:false,canReplayUnknownToolEffects:false,
    }};
}
export async function inspectLiveRuntimeRollout(corePort=7888):Promise<RuntimeRolloutDecision> {
 const ownership=await captureRuntimeOwnership(corePort);
 const authenticatedOAuth=ownership.mcp.filter(m=>
   m.authMode==="oauth"&&m.state==="os_pid_correlated_only"&&
   m.authenticationVerified&&m.publicTunnelVerified);
 const independentOwnerVerified=authenticatedOAuth.length>0;
 const noSharedLegacyOwner=ownership.ownershipTopology!=="shared_owner_do_not_cutover"&&
   independentOwnerVerified;
 // Fail closed for certification evidence we cannot prove from a local owner
 // probe. Unlike the previous implementation, do not fabricate "owner
 // unverified" when the authenticated managed-owner control channel succeeds.
 return assessRuntimeRollout({
   topology:ownership,
   privateOAuthIssuerVerified:independentOwnerVerified,
   windowsKeystoreAndAclVerified:false,
   liveIssuerTlsVerified:false,
   separateIngressVerified:independentOwnerVerified,
   desktopNativeE2EVerified:false,
   extendedSoakVerified:false,
   oauthClientsReauthorized:false,
   legacyMcpSessions:noSharedLegacyOwner?0:null,
   pendingExternalEffects:null,
   reversibleClientRoutingVerified:false,
   operatorApprovalForLiveCutover:false,
 });
}
