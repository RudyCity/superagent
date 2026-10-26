/**
 * Phase 5n: offline OAuth handover gates, not OAuth/token migration.
 * Current MCP OAuth store is in-memory and must not be serialized or copied.
 */
export interface McpOAuthMigrationEvidence {
  sharedLegacyCoreOwner:boolean;
  independentOwnerVerified:boolean;
  newIssuerConfigured:boolean;
  publicMcpEndpointMatched:boolean;
  clientsReauthorized:boolean;
  activeLegacySessions:number|null;
  pendingToolEffects:number|null;
  rollbackPathVerified:boolean;
  operatorApproved:boolean;
}
export interface McpOAuthMigrationDecision {
  version:1;status:"blocked"|"manual_reconnect_candidate";
  blockers:string[];
  nextActions:string[];
  tokenExportPermitted:false;
  legacyProcessTerminationPermitted:false;
  liveSessionTransferPermitted:false;
  automaticCutoverPermitted:false;
  sessionReauthorizationRequired:true;
}
export function assessMcpOAuthMigration(e:McpOAuthMigrationEvidence):McpOAuthMigrationDecision{
  for(const n of [e.activeLegacySessions,e.pendingToolEffects]){
    if(n!==null&&(!Number.isSafeInteger(n)||n<0))throw new Error("Invalid MCP handover evidence");
  }
  const blockers:string[]=[];
  if(e.sharedLegacyCoreOwner)blockers.push("LEGACY_CORE_AND_MCP_SHARE_PROCESS");
  if(!e.independentOwnerVerified)blockers.push("NEW_MCP_OWNER_UNVERIFIED");
  if(!e.newIssuerConfigured)blockers.push("OAUTH_ISSUER_NOT_CONFIGURED");
  if(!e.publicMcpEndpointMatched)blockers.push("PUBLIC_ENDPOINT_NOT_VERIFIED");
  if(!e.clientsReauthorized)blockers.push("CLIENTS_MUST_REAUTHORIZE");
  if(e.activeLegacySessions===null||e.activeLegacySessions>0)
    blockers.push("LEGACY_SESSION_DRAIN_NOT_PROVEN");
  if(e.pendingToolEffects===null||e.pendingToolEffects>0)
    blockers.push("UNKNOWN_EXTERNAL_TOOL_EFFECTS");
  if(!e.rollbackPathVerified)blockers.push("ROLLBACK_NOT_VERIFIED");
  if(!e.operatorApproved)blockers.push("OPERATOR_APPROVAL_REQUIRED");
  return {version:1,
    status:blockers.length?"blocked":"manual_reconnect_candidate",
    blockers,nextActions:[
      "KEEP_LEGACY_MCP_LISTENER_RUNNING",
      "DEPLOY_INDEPENDENT_OAUTH_OWNER_WITH_SEPARATE_CREDENTIAL_STORAGE",
      "VERIFY_OAUTH_ISSUER_DISCOVERY_AND_SCOPES",
      "REAUTHORIZE_EACH_CLIENT_WITH_PKCE",
      "RECONCILE_PENDING_TOOLS_AND_DRAIN_LEGACY_SESSIONS",
      "PROVE_ROLLBACK_BEFORE_MANUAL_ENDPOINT_CUTOVER",
    ],
    tokenExportPermitted:false,
    legacyProcessTerminationPermitted:false,
    liveSessionTransferPermitted:false,
    automaticCutoverPermitted:false,
    sessionReauthorizationRequired:true,
  };
}
