/**
 * Read-only OAuth discovery verifier for the operator-owned Named MCP host.
 *
 * This checks public metadata only. It NEVER sends credentials, opens
 * authorization flows, creates OAuth clients, or approves a Gemini cutover.
 * A successful discovery result still requires manual PKCE + tools/list E2E.
 */
import {validateMcpNamedHostname} from "./mcpNamedTunnelConfig.js";

export type NamedOAuthCode =
  | "AUTHORIZATION_DISCOVERY_UNAVAILABLE"
  | "AUTHORIZATION_DISCOVERY_MISMATCH"
  | "RESOURCE_DISCOVERY_UNAVAILABLE"
  | "RESOURCE_DISCOVERY_MISMATCH"
  | "PKCE_S256_MISSING"
  | "PUBLIC_MCP_CHALLENGE_MISSING"
  | "PUBLIC_MCP_UNAVAILABLE";

export interface NamedOAuthDiscoveryEvidence {
  hostname:string;
  issuer:string;
  discoveryHttpStatus:number|null;
  resourceHttpStatus:number|null;
  mcpHttpStatus:number|null;
  authorizationServerMetadataVerified:boolean;
  protectedResourceMetadataVerified:boolean;
  pkceS256Advertised:boolean;
  mcpBearerChallengeObserved:boolean;
  metadataOnlyComplete:boolean;
  geminiClientAuthorized:false;
  cutoverApproved:false;
  readyForCutover:false;
  reasonCodes:NamedOAuthCode[];
  requestMethods:readonly ["GET","GET","HEAD"];
}
export type SafePublicFetch=(input:string|URL|Request,init?:RequestInit)=>Promise<Response>;
const MAX_JSON_BYTES=16_384;
const OAUTH_PATH="/.well-known/oauth-authorization-server";
const RESOURCE_PATH="/.well-known/oauth-protected-resource/mcp";

function object(value:unknown):Record<string,unknown>|null {
  return value!==null&&typeof value==="object"&&!Array.isArray(value)
    ? value as Record<string,unknown> : null;
}
function exactStringArray(v:unknown):string[] {
  return Array.isArray(v)&&v.every(x=>typeof x==="string") ? v : [];
}
function exactIssuerEndpoint(v:unknown,issuer:string,endpoint:string):boolean {
  return typeof v==="string"&&v===issuer+endpoint;
}
async function boundedJson(response:Response):Promise<Record<string,unknown>|null> {
  if(response.status!==200)return null;
  const type=response.headers.get("content-type")||"";
  if(!/^(application\/json|application\/[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(type)){
    return null;
  }
  const declared=response.headers.get("content-length");
  if(declared!==null&&Number(declared)>MAX_JSON_BYTES)return null;
  const reader=response.body?.getReader();
  if(!reader)return null;
  const chunks:Uint8Array[]=[];
  let total=0;
  try{
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      if(!value)continue;
      total+=value.byteLength;
      if(total>MAX_JSON_BYTES){await reader.cancel();return null;}
      chunks.push(value);
    }
  }catch{
    return null;
  }finally{
    reader.releaseLock();
  }
  const data=new Uint8Array(total);
  let offset=0;
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
  try{return object(JSON.parse(new TextDecoder().decode(data)));}catch{return null;}
}
function authorizationOk(meta:Record<string,unknown>|null,base:string):boolean {
  return !!meta&&meta.issuer===base&&
    exactIssuerEndpoint(meta.authorization_endpoint,base,"/oauth/authorize")&&
    exactIssuerEndpoint(meta.token_endpoint,base,"/oauth/token")&&
    exactIssuerEndpoint(meta.registration_endpoint,base,"/oauth/register")&&
    exactStringArray(meta.response_types_supported).includes("code")&&
    exactStringArray(meta.grant_types_supported).includes("authorization_code")&&
    exactStringArray(meta.token_endpoint_auth_methods_supported).includes("none");
}
function protectedResourceOk(meta:Record<string,unknown>|null,base:string):boolean {
  return !!meta&&meta.resource===base+"/mcp"&&
    exactStringArray(meta.authorization_servers).includes(base)&&
    exactStringArray(meta.bearer_methods_supported).includes("header");
}
const add=(codes:NamedOAuthCode[],code:NamedOAuthCode)=>{
  if(!codes.includes(code))codes.push(code);
};
export async function probeNamedOAuthDiscovery(
  hostname:string,
  fetchPublic:SafePublicFetch=fetch,
):Promise<NamedOAuthDiscoveryEvidence> {
  const host=validateMcpNamedHostname(hostname);
  const base="https://"+host;
  const status:NamedOAuthDiscoveryEvidence={
    hostname:host,issuer:base,
    discoveryHttpStatus:null,resourceHttpStatus:null,mcpHttpStatus:null,
    authorizationServerMetadataVerified:false,
    protectedResourceMetadataVerified:false,
    pkceS256Advertised:false,mcpBearerChallengeObserved:false,
    metadataOnlyComplete:false,geminiClientAuthorized:false,
    cutoverApproved:false,readyForCutover:false,
    reasonCodes:[],requestMethods:["GET","GET","HEAD"],
  };
  // Never make requests to a returned issuer or authorization_endpoint: only
  // exact operator-owned paths. Requests carry no cookies, OAuth bearer, or
  // Cloudflare token, and redirects never follow.
  const endpoints=[
    {path:OAUTH_PATH,method:"GET" as const},
    {path:RESOURCE_PATH,method:"GET" as const},
    {path:"/mcp",method:"HEAD" as const},
  ];
  const responses:(Response|null)[]=[];
  for(const item of endpoints){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),5000);
    try{
      responses.push(await fetchPublic(base+item.path,{
        method:item.method,
        redirect:"manual",
        credentials:"omit",
        referrerPolicy:"no-referrer",
        cache:"no-store",
        headers:{Accept:item.method==="GET"?"application/json":"*/*"},
        signal:controller.signal,
      }));
    }catch{responses.push(null);}
    finally{clearTimeout(timer);}
  }
  status.discoveryHttpStatus=responses[0]?.status??null;
  status.resourceHttpStatus=responses[1]?.status??null;
  status.mcpHttpStatus=responses[2]?.status??null;

  const auth=responses[0]?await boundedJson(responses[0]):null;
  const resource=responses[1]?await boundedJson(responses[1]):null;
  status.authorizationServerMetadataVerified=authorizationOk(auth,base);
  status.protectedResourceMetadataVerified=protectedResourceOk(resource,base);
  status.pkceS256Advertised=
    exactStringArray(auth?.code_challenge_methods_supported).includes("S256");
  status.mcpBearerChallengeObserved=responses[2]?.status===401&&
    /^Bearer(?:\s|$)/i.test(responses[2]?.headers.get("www-authenticate")?.trim()??"");

  if(!responses[0]||responses[0].status!==200)
    add(status.reasonCodes,"AUTHORIZATION_DISCOVERY_UNAVAILABLE");
  else if(!status.authorizationServerMetadataVerified)
    add(status.reasonCodes,"AUTHORIZATION_DISCOVERY_MISMATCH");
  if(!responses[1]||responses[1].status!==200)
    add(status.reasonCodes,"RESOURCE_DISCOVERY_UNAVAILABLE");
  else if(!status.protectedResourceMetadataVerified)
    add(status.reasonCodes,"RESOURCE_DISCOVERY_MISMATCH");
  if(!status.pkceS256Advertised)add(status.reasonCodes,"PKCE_S256_MISSING");
  if(!responses[2]||[502,503,520,521,522,523,524,525,526,530].includes(responses[2].status))
    add(status.reasonCodes,"PUBLIC_MCP_UNAVAILABLE");
  else if(!status.mcpBearerChallengeObserved)
    add(status.reasonCodes,"PUBLIC_MCP_CHALLENGE_MISSING");

  status.metadataOnlyComplete=status.authorizationServerMetadataVerified&&
    status.protectedResourceMetadataVerified&&status.pkceS256Advertised&&
    status.mcpBearerChallengeObserved;
  // Intentionally always false: metadata is NEVER the user's PKCE consent.
  return status;
}
