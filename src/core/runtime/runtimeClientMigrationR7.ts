/**
 * R7 per-client migration evidence. Read-only decision, not a transport switch.
 * Evidence here is operator-supplied: a candidate is NOT proof that an external
 * client has been moved, nor a permission to terminate the legacy owner.
 */
import type {RuntimeRolloutDecision} from "./runtimeReleaseGateR7.js";

export interface RuntimeClientMigrationEvidence {
  /** A SHA-256 fingerprint of a separately inventoried client ID. Never an ID/token. */
  clientFingerprint:string;
  oldIssuer:string;
  candidateIssuer:string;
  /** The current live, fail-closed R6/R7 global gate. */
  releaseDecision:RuntimeRolloutDecision;
  pkceS256Exchanged:boolean;
  newResourceAudienceVerified:boolean;
  newAccessTokenVerified:boolean;
  newRefreshRotationVerified:boolean;
  clientReauthorizedByOwner:boolean;
  legacyClientSessions:number|null;
  pendingExternalEffects:number|null;
  candidateClientConnectivityVerified:boolean;
  rollbackRouteTested:boolean;
  operatorReviewed:boolean;
  operatorApproved:boolean;
}
export interface RuntimeClientMigrationDecision {
  version:1;
  status:"blocked"|"operator_canary_review_candidate";
  clientFingerprint:string;
  blockers:string[];
  allowedActions:["READ_ONLY_REPORT"];
  automaticCutoverAllowed:false;
  legacyTokenCopyAllowed:false;
  terminateLegacyOwnerAllowed:false;
  replayUnknownToolEffectsAllowed:false;
}

/** Strict issuer URL check for a *public* per-client cutover plan. */
export function canonicalPublicIssuer(raw:string):string|null {
  try {
    const url=new URL(raw);
    if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||
       url.port && url.port!=="443"||url.hostname==="localhost"||
       url.hostname==="127.0.0.1"||url.hostname==="::1"||
       url.hostname.endsWith(".localhost")||
       /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)||
       url.hostname.includes(":")||raw!==raw.trim())return null;
    if(!/^[a-z0-9.-]+$/.test(url.hostname)||url.hostname.startsWith(".")||
       !url.hostname.includes(".")||url.hostname.endsWith("."))return null;
    return url.origin+url.pathname.replace(/\/+$/,"");
  } catch { return null; }
}
export function assessRuntimeClientMigration(
  e:RuntimeClientMigrationEvidence,
):RuntimeClientMigrationDecision {
  if(!/^[a-f0-9]{64}$/.test(e.clientFingerprint))
    throw new Error("Client fingerprint must be a SHA-256 hex digest; no raw client identifiers");
  for(const count of [e.legacyClientSessions,e.pendingExternalEffects])
    if(count!==null&&(!Number.isSafeInteger(count)||count<0))
      throw new Error("Invalid client migration counter");
  const blockers:string[]=[];
  const old=canonicalPublicIssuer(e.oldIssuer);
  const candidate=canonicalPublicIssuer(e.candidateIssuer);
  if(!old||!candidate||old===candidate)blockers.push("DISTINCT_PUBLIC_ISSUERS_NOT_VERIFIED");
  // The global live gate cannot be overridden with optimistic client evidence.
  if(e.releaseDecision.version!==1||e.releaseDecision.status!=="manual_cutover_review_candidate"||
     e.releaseDecision.blockers.length!==0)
    blockers.push("GLOBAL_RELEASE_GATE_NOT_CERTIFIED");
  if(!e.pkceS256Exchanged)blockers.push("PKCE_CLIENT_EXCHANGE_UNVERIFIED");
  if(!e.newResourceAudienceVerified)blockers.push("NEW_RESOURCE_AUDIENCE_UNVERIFIED");
  if(!e.newAccessTokenVerified||!e.newRefreshRotationVerified)
    blockers.push("NEW_CREDENTIAL_LIFECYCLE_UNVERIFIED");
  if(!e.clientReauthorizedByOwner)blockers.push("CLIENT_REAUTHORIZATION_REQUIRED");
  if(e.legacyClientSessions!==0)blockers.push("LEGACY_CLIENT_SESSIONS_NOT_DRAINED");
  if(e.pendingExternalEffects!==0)blockers.push("EXTERNAL_EFFECTS_UNRECONCILED");
  if(!e.candidateClientConnectivityVerified)blockers.push("CANDIDATE_CONNECTIVITY_UNVERIFIED");
  if(!e.rollbackRouteTested)blockers.push("CLIENT_ROLLBACK_NOT_VERIFIED");
  if(!e.operatorReviewed||!e.operatorApproved)blockers.push("EXPLICIT_OPERATOR_APPROVAL_REQUIRED");
  return {
    version:1,
    status:blockers.length?"blocked":"operator_canary_review_candidate",
    clientFingerprint:e.clientFingerprint,
    blockers,
    allowedActions:["READ_ONLY_REPORT"],
    automaticCutoverAllowed:false,
    legacyTokenCopyAllowed:false,
    terminateLegacyOwnerAllowed:false,
    replayUnknownToolEffectsAllowed:false,
  };
}
