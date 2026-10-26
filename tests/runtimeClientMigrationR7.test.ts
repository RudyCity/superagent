import {describe,expect,it} from "vitest";
import {assessRuntimeClientMigration,canonicalPublicIssuer} from "../src/core/runtime/runtimeClientMigrationR7.js";
import type {RuntimeClientMigrationEvidence} from "../src/core/runtime/runtimeClientMigrationR7.js";
const certified={
  version:1 as const,phase:"R6_R7_release_gate" as const,
  status:"manual_cutover_review_candidate" as const,blockers:[],
  decisions:{
    oauthTokenImportAllowed:false as const,automaticLiveCutoverAllowed:false as const,
    canStopSharedCorePid:false as const,canReplayUnknownToolEffects:false as const,
  },
};
const good:RuntimeClientMigrationEvidence={
  clientFingerprint:"a".repeat(64),
  oldIssuer:"https://legacy.example.net/mcp",
  candidateIssuer:"https://next.example.net/mcp",
  releaseDecision:certified,pkceS256Exchanged:true,
  newResourceAudienceVerified:true,newAccessTokenVerified:true,
  newRefreshRotationVerified:true,clientReauthorizedByOwner:true,
  legacyClientSessions:0,pendingExternalEffects:0,
  candidateClientConnectivityVerified:true,rollbackRouteTested:true,
  operatorReviewed:true,operatorApproved:true,
};
describe("R7 read-only per-client canary gate",()=>{
  it("does not authorize actions even with fully attested evidence",()=>{
    const result=assessRuntimeClientMigration(good);
    expect(result.status).toBe("operator_canary_review_candidate");
    expect(result.allowedActions).toEqual(["READ_ONLY_REPORT"]);
    expect(result.automaticCutoverAllowed).toBe(false);
    expect(result.terminateLegacyOwnerAllowed).toBe(false);
  });
  it("blocks if production release gate is still red",()=>{
    const result=assessRuntimeClientMigration({...good,releaseDecision:{
      ...certified,status:"blocked",blockers:["LEGACY_CORE_AND_MCP_SHARE_PROCESS"],
    }});
    expect(result.blockers).toContain("GLOBAL_RELEASE_GATE_NOT_CERTIFIED");
  });
  it("requires per-client PKCE and independently verified audience",()=>{
    const result=assessRuntimeClientMigration({...good,
      pkceS256Exchanged:false,newResourceAudienceVerified:false});
    expect(result.blockers).toContain("PKCE_CLIENT_EXCHANGE_UNVERIFIED");
    expect(result.blockers).toContain("NEW_RESOURCE_AUDIENCE_UNVERIFIED");
  });
  it("does not treat unknown sessions or effects as zero",()=>{
    const result=assessRuntimeClientMigration({...good,
      legacyClientSessions:null,pendingExternalEffects:null});
    expect(result.blockers).toContain("LEGACY_CLIENT_SESSIONS_NOT_DRAINED");
    expect(result.blockers).toContain("EXTERNAL_EFFECTS_UNRECONCILED");
  });
  it("rejects secrets or raw IDs in client fingerprint field",()=>{
    expect(()=>assessRuntimeClientMigration({...good,
      clientFingerprint:"client@example.com"})).toThrow(/fingerprint/);
  });
  it("rejects negative, fractional and unsafe counters",()=>{
    for(const n of [-1,1.2,Number.MAX_SAFE_INTEGER+1])
      expect(()=>assessRuntimeClientMigration({...good,legacyClientSessions:n})).toThrow();
  });
  it("requires separate verified https origins, never localhost or embedded credentials",()=>{
    for(const url of ["http://next.example.net", "https://localhost/mcp",
      "https://127.0.0.1/mcp","https://[::1]/mcp",
      "https://user:pass@next.example.net/mcp",
      "https://next.example.net/mcp?token=x","https://next.example.net/mcp#token",
      "https://next.example.net:444/mcp","https://next.example.net./mcp"]) {
      expect(canonicalPublicIssuer(url)).toBeNull();
      expect(assessRuntimeClientMigration({...good,candidateIssuer:url}).status).toBe("blocked");
    }
    expect(assessRuntimeClientMigration({...good,candidateIssuer:good.oldIssuer})
      .blockers).toContain("DISTINCT_PUBLIC_ISSUERS_NOT_VERIFIED");
  });
  it("blocks unreviewed or unapproved candidate without changing route",()=>{
    const result=assessRuntimeClientMigration({...good,operatorApproved:false});
    expect(result.status).toBe("blocked");
    expect(result.blockers).toContain("EXPLICIT_OPERATOR_APPROVAL_REQUIRED");
  });
});
