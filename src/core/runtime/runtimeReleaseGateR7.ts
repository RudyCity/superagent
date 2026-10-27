/**
 * R6/R7 release/cutover gate. This report cannot commit a routing mutation.
 * It will never treat a scoped staging success as live client migration.
 */
import {assessMcpOAuthMigration} from "./mcpOAuthMigrationPolicy.js";
import type {RuntimeOwnershipContract} from "./runtimeOwnershipContract.js";
import {captureRuntimeOwnership} from "./runtimeOwnershipContract.js";
import {
  inspectLiveRuntimeSecurity,
  readRuntimeProductionCertificate,
} from "./runtimeProductionCertificate.js";
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
  // Current independent owners must be authenticated and OS-correlated, but
  // must NOT be put into drain merely to pass a health audit. Legacy-session
  // drain is represented separately by legacyMcpSessions.
  if(e.topology.mcp.length===0||e.topology.mcp.some(m=>!m.authenticationVerified))
    blockers.push("MCP_AUTHENTICATION_NOT_VERIFIED");
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
 const live=await inspectLiveRuntimeSecurity(ownership,corePort);
 const cert=readRuntimeProductionCertificate(corePort);
 return assessRuntimeRollout({
   topology:ownership,
   privateOAuthIssuerVerified:live.privateOAuthIssuerVerified,
   windowsKeystoreAndAclVerified:live.windowsKeystoreAndAclVerified,
   liveIssuerTlsVerified:live.liveIssuerTlsVerified,
   separateIngressVerified:live.separateIngressVerified,
   desktopNativeE2EVerified:cert?.tline.passed===true,
   extendedSoakVerified:cert?.soak.passed===true,
   oauthClientsReauthorized:live.oauthClientsReauthorized,
   legacyMcpSessions:live.legacyMcpSessions,
   pendingExternalEffects:live.pendingExternalEffects,
   reversibleClientRoutingVerified:cert?.rollback.passed===true,
   operatorApprovalForLiveCutover:Boolean(cert?.operatorApprovedAt),
 });
}
