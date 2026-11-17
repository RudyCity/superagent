/**
 * Redacted classifications for attended, read-only MCP runtime acceptance.
 * Never emit a remote exception message: it may embed URLs, bearer tokens,
 * OAuth credentials, raw request bodies or private host identifiers.
 */
export type LiveVerificationPhase =
  | "preflight" | "owner" | "mcp_connect" | "mcp_catalog"
  | "mcp_status" | "owner_postflight" | "close";

export type LiveVerificationFailureCode =
  | "MCP_POLICY_LIVE_TIMEOUT" | "MCP_POLICY_AUTH_REJECTED"
  | "MCP_POLICY_DNS_UNAVAILABLE" | "MCP_POLICY_CONNECTION_REFUSED"
  | "MCP_POLICY_TLS_REJECTED" | "MCP_POLICY_REMOTE_FAILURE"
  | "MCP_POLICY_LIVE_FAILED";

function errorCodes(error:unknown, seen=new Set<unknown>()):string[] {
  if(!error || typeof error!=="object" || seen.has(error) || seen.size>=6)return [];
  seen.add(error);
  const node=error as {code?:unknown;status?:unknown;statusCode?:unknown;cause?:unknown};
  const codes:string[]=[];
  if(typeof node.code==="string")codes.push(node.code.toUpperCase());
  for(const v of [node.status,node.statusCode]){
    if(typeof v==="number"&&Number.isFinite(v))codes.push(String(v));
  }
  if(node.cause)codes.push(...errorCodes(node.cause,seen).slice(0,5));
  return codes;
}

/** Classify by codes/HTTP status only, never by possibly-secret error text. */
export function classifyLiveMcpFailure(error:unknown):LiveVerificationFailureCode {
  const codes=errorCodes(error);
  if(codes.includes("MCP_POLICY_DEADLINE") || codes.includes("ETIMEDOUT") ||
     codes.includes("UND_ERR_CONNECT_TIMEOUT"))
    return "MCP_POLICY_LIVE_TIMEOUT";
  if(codes.includes("401")||codes.includes("403")||codes.includes("UNAUTHORIZED"))
    return "MCP_POLICY_AUTH_REJECTED";
  if(codes.includes("ENOTFOUND")||codes.includes("EAI_AGAIN"))
    return "MCP_POLICY_DNS_UNAVAILABLE";
  if(codes.includes("ECONNREFUSED")||codes.includes("ECONNRESET")||codes.includes("EPIPE"))
    return "MCP_POLICY_CONNECTION_REFUSED";
  if(codes.some(code=>code.startsWith("ERR_TLS")||code.includes("CERT_")||
      code==="DEPTH_ZERO_SELF_SIGNED_CERT"||code==="UNABLE_TO_VERIFY_LEAF_SIGNATURE"))
    return "MCP_POLICY_TLS_REJECTED";
  if(codes.some(code=>/^5\d\d$/.test(code)))
    return "MCP_POLICY_REMOTE_FAILURE";
  return "MCP_POLICY_LIVE_FAILED";
}
