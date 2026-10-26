/**
 * Read-only metadata parity gate for a future public MCP ingress.
 * It cannot change a route, trust a proxy, or certify public TLS itself.
 */
export interface OAuthIngressMetadata {
  issuer?:unknown;
  authorization_endpoint?:unknown;
  token_endpoint?:unknown;
  registration_endpoint?:unknown;
  code_challenge_methods_supported?:unknown;
  grant_types_supported?:unknown;
  resource_indicators_supported?:unknown;
}
export interface OAuthResourceMetadata {
  resource?:unknown;
  authorization_servers?:unknown;
}
export interface PublicIssuerParityDecision {
  version:1;
  phase:"R3_public_issuer_parity";
  status:"blocked"|"metadata_review_candidate";
  blockers:string[];
  liveRoutingAllowed:false;
  oauthTokenImportAllowed:false;
}
function publicIssuerOrigin(raw:string):string|null{
  try{
    const u=new URL(raw);
    if(u.protocol!=="https:"||u.username||u.password||
       u.search||u.hash||u.pathname!=="/"||
       u.hostname==="localhost"||u.hostname.endsWith(".localhost")||
       u.hostname.includes(":")||/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)||
       !u.hostname.includes(".")||!/[a-z]/i.test(u.hostname)||
       raw!==raw.trim())return null;
    return u.origin;
  }catch{return null;}
}
/** All exact values must be observed from the NEW ingress, never synthesized. */
export function assessPublicIssuerParity(input:{
  expectedPublicIssuer:string;
  authorizationServer:OAuthIngressMetadata|null;
  protectedResource:OAuthResourceMetadata|null;
}):PublicIssuerParityDecision {
  const blockers:string[]=[];
  const issuer=publicIssuerOrigin(input.expectedPublicIssuer);
  if(!issuer)blockers.push("INVALID_PUBLIC_ISSUER");
  const auth=input.authorizationServer;
  const resource=input.protectedResource;
  if(!auth||!resource)blockers.push("DISCOVERY_RESPONSES_MISSING");
  if(issuer&&auth){
    if(auth.issuer!==issuer)blockers.push("ISSUER_IDENTITY_MISMATCH");
    for(const [key,suffix] of [
      ["authorization_endpoint","/oauth/authorize"],
      ["token_endpoint","/oauth/token"],
      ["registration_endpoint","/oauth/register"],
    ] as const){
      if(auth[key]!==issuer+suffix)
        blockers.push("OAUTH_ENDPOINT_PARITY_"+key.toUpperCase());
    }
    if(!Array.isArray(auth.code_challenge_methods_supported)||
       !auth.code_challenge_methods_supported.includes("S256"))
      blockers.push("PKCE_S256_NOT_ADVERTISED");
    if(!Array.isArray(auth.grant_types_supported)||
       !auth.grant_types_supported.includes("authorization_code")||
       !auth.grant_types_supported.includes("refresh_token"))
      blockers.push("OAUTH_GRANTS_NOT_ADVERTISED");
    if(auth.resource_indicators_supported!==true)
      blockers.push("RESOURCE_INDICATORS_NOT_ADVERTISED");
  }
  if(issuer&&resource){
    if(resource.resource!==issuer+"/mcp")
      blockers.push("PROTECTED_RESOURCE_IDENTITY_MISMATCH");
    if(!Array.isArray(resource.authorization_servers)||
       resource.authorization_servers.length!==1||
       resource.authorization_servers[0]!==issuer)
      blockers.push("PROTECTED_RESOURCE_ISSUER_MISMATCH");
  }
  return {version:1,phase:"R3_public_issuer_parity",
    status:blockers.length?"blocked":"metadata_review_candidate",blockers,
    liveRoutingAllowed:false,oauthTokenImportAllowed:false};
}
