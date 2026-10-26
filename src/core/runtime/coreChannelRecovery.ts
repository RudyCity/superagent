/**
 * Phase 5i — model a safe boundary between in-memory agents and independently
 * owned channel transports. This never fabricates a session or adopts OAuth.
 */
export type RecoveryChannel = "tline"|"mcp_oauth"|"muse"|"telegram"|"web_chat";
export interface ChannelRecoveryEvidence {
  channel:RecoveryChannel;
  transportAlive:boolean;
  ownerVerified:boolean;
  credentialContinuityVerified:boolean;
  originalSessionExists:boolean;
  ambiguousExecutionCount:number|null;
  durableHistoryVerified:boolean;
  approvedByUser:boolean;
}
export type ChannelRecoveryAction =
  "keep_existing_transport"|"read_only_probe"|"require_reauthentication"|
  "operator_review"|"explicit_session_resume";
export interface ChannelRecoveryDecision {
  channel:RecoveryChannel; action:ChannelRecoveryAction; reason:string;
  replayToolCalls:false; rotateCredentialsAutomatically:false;
  restartProcess:false; preserveExistingSessionId:true;
}
export function decideChannelRecovery(e:ChannelRecoveryEvidence):ChannelRecoveryDecision {
  if (e.ambiguousExecutionCount!==null&&
      (!Number.isSafeInteger(e.ambiguousExecutionCount)||e.ambiguousExecutionCount<0))
    throw new Error("Invalid execution evidence");
  const done=(action:ChannelRecoveryAction,reason:string):ChannelRecoveryDecision=>({
    channel:e.channel,action,reason,replayToolCalls:false,
    rotateCredentialsAutomatically:false,restartProcess:false,preserveExistingSessionId:true,
  });
  if(!e.ownerVerified) return done("operator_review","CHANNEL_OWNER_UNVERIFIED");
  if(!e.transportAlive) return done("read_only_probe","TRANSPORT_NOT_LIVE");
  if(e.channel==="mcp_oauth"&&!e.credentialContinuityVerified)
    return done("require_reauthentication","MCP_OAUTH_MUST_NOT_BE_SILENTLY_REPLACED");
  if(!e.credentialContinuityVerified)
    return done("operator_review","CHANNEL_AUTHENTICATION_NOT_VERIFIED");
  if(e.originalSessionExists) return done("keep_existing_transport","EXISTING_CHANNEL_SESSION_RETAINED");
  if(e.ambiguousExecutionCount===null||e.ambiguousExecutionCount>0)
    return done("operator_review","UNRESOLVED_AGENT_OR_TOOL_EFFECTS");
  if(!e.durableHistoryVerified) return done("operator_review","DURABLE_HISTORY_REQUIRED");
  if(e.channel==="mcp_oauth"||e.channel==="muse"||e.channel==="telegram")
    return done("operator_review","CHANNEL_SPECIFIC_AUTHENTICATED_RESUME_REQUIRED");
  if(!e.approvedByUser) return done("operator_review","EXPLICIT_USER_RESUME_APPROVAL_REQUIRED");
  return done("explicit_session_resume","RESUME_POSSIBLE_WITH_SERVER_SIDE_REVALIDATION");
}
