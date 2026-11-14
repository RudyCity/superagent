import {describe,expect,it,vi} from "vitest";
import {
  probeNamedOAuthDiscovery,type SafePublicFetch,
} from "../src/core/runtime/mcpNamedOAuthReadiness.js";

const host="mcp.rcity.web.id";
const base="https://"+host;
const auth={
  issuer:base,
  authorization_endpoint:base+"/oauth/authorize",
  token_endpoint:base+"/oauth/token",
  registration_endpoint:base+"/oauth/register",
  response_types_supported:["code"],
  grant_types_supported:["authorization_code","refresh_token"],
  token_endpoint_auth_methods_supported:["none"],
  code_challenge_methods_supported:["S256"],
};
const resource={
  resource:base+"/mcp",
  authorization_servers:[base],
  bearer_methods_supported:["header"],
};
const json=(body:unknown,status=200)=>
  new Response(JSON.stringify(body),{
    status,headers:{"Content-Type":"application/json"},
  });
function fakeFetch(options:{
  auth?:Record<string,unknown>;
  resource?:Record<string,unknown>;
  authStatus?:number;
  resourceStatus?:number;
  mcpStatus?:number;
  mcpChallenge?:string;
}={}):{fn:SafePublicFetch;calls:Array<{url:string;init:RequestInit|undefined}>}{
  const calls:Array<{url:string;init:RequestInit|undefined}>=[];
  const fn:SafePublicFetch=vi.fn(async(input,init)=>{
    const url=String(input);
    calls.push({url,init});
    if(url===base+"/.well-known/oauth-authorization-server"){
      return options.authStatus&&options.authStatus!==200
        ?new Response("unavailable",{status:options.authStatus})
        :json(options.auth??auth);
    }
    if(url===base+"/.well-known/oauth-protected-resource/mcp"){
      return options.resourceStatus&&options.resourceStatus!==200
        ?new Response("unavailable",{status:options.resourceStatus})
        :json(options.resource??resource);
    }
    if(url===base+"/mcp")return new Response(null,{
      status:options.mcpStatus??401,
      headers:{"WWW-Authenticate":
        options.mcpChallenge??'Bearer realm="mcp"'},
    });
    throw Error("Unauthorized external request");
  });
  return {fn,calls};
}
describe("Named Tunnel MCP OAuth discovery (read-only / fail closed)",()=>{
  it("verifies exact issuer, resource, PKCE and bearer challenge but never approves Gemini",async()=>{
    const f=fakeFetch();
    const e=await probeNamedOAuthDiscovery(host,f.fn);
    expect(e).toMatchObject({
      hostname:host,issuer:base,
      authorizationServerMetadataVerified:true,
      protectedResourceMetadataVerified:true,pkceS256Advertised:true,
      mcpBearerChallengeObserved:true,metadataOnlyComplete:true,
      geminiClientAuthorized:false,cutoverApproved:false,readyForCutover:false,
      reasonCodes:[],
    });
    expect(f.calls.map(x=>x.url)).toEqual([
      base+"/.well-known/oauth-authorization-server",
      base+"/.well-known/oauth-protected-resource/mcp",base+"/mcp",
    ]);
    expect(f.calls.map(x=>x.init?.method)).toEqual(["GET","GET","HEAD"]);
    for(const call of f.calls){
      expect(call.init?.redirect).toBe("manual");
      expect(call.init?.credentials).toBe("omit");
      expect(JSON.stringify(call.init)).not.toMatch(/authorization|client_secret|token|cookie/i);
    }
  });
  it("rejects discovery belonging to the old Quick Tunnel OAuth issuer",async()=>{
    const f=fakeFetch({auth:{...auth,issuer:"https://example.trycloudflare.com"}});
    const e=await probeNamedOAuthDiscovery(host,f.fn);
    expect(e.authorizationServerMetadataVerified).toBe(false);
    expect(e.reasonCodes).toContain("AUTHORIZATION_DISCOVERY_MISMATCH");
    expect(e.readyForCutover).toBe(false);
  });
  it("rejects authorization and token endpoints redirected to an attacker origin",async()=>{
    const f=fakeFetch({auth:{...auth,
      token_endpoint:"https://attacker.example/oauth/token",
    }});
    const e=await probeNamedOAuthDiscovery(host,f.fn);
    expect(e.authorizationServerMetadataVerified).toBe(false);
    expect(e.reasonCodes).toContain("AUTHORIZATION_DISCOVERY_MISMATCH");
  });
  it("rejects missing PKCE S256 even when endpoints otherwise match",async()=>{
    const f=fakeFetch({auth:{...auth,code_challenge_methods_supported:["plain"]}});
    const e=await probeNamedOAuthDiscovery(host,f.fn);
    expect(e.authorizationServerMetadataVerified).toBe(true);
    expect(e.pkceS256Advertised).toBe(false);
    expect(e.reasonCodes).toContain("PKCE_S256_MISSING");
  });
  it("rejects a protected resource pointing at the wrong hostname",async()=>{
    const f=fakeFetch({resource:{...resource,resource:"https://example.com/mcp"}});
    const e=await probeNamedOAuthDiscovery(host,f.fn);
    expect(e.protectedResourceMetadataVerified).toBe(false);
    expect(e.reasonCodes).toContain("RESOURCE_DISCOVERY_MISMATCH");
  });
  it("recognizes HTTP 530 as an offline Cloudflare connector, not a healthy MCP",async()=>{
    const f=fakeFetch({mcpStatus:530,mcpChallenge:""});
    const e=await probeNamedOAuthDiscovery(host,f.fn);
    expect(e.mcpHttpStatus).toBe(530);
    expect(e.metadataOnlyComplete).toBe(false);
    expect(e.reasonCodes).toContain("PUBLIC_MCP_UNAVAILABLE");
  });
  it("does not follow redirects from discovery, and fails closed",async()=>{
    const f=fakeFetch({authStatus:302,resourceStatus:302,mcpStatus:503});
    const e=await probeNamedOAuthDiscovery(host,f.fn);
    expect(e.authorizationServerMetadataVerified).toBe(false);
    expect(e.protectedResourceMetadataVerified).toBe(false);
    expect(e.reasonCodes).toContain("AUTHORIZATION_DISCOVERY_UNAVAILABLE");
    expect(e.reasonCodes).toContain("RESOURCE_DISCOVERY_UNAVAILABLE");
    expect(e.readyForCutover).toBe(false);
    expect(f.calls).toHaveLength(3);
  });
  it("rejects Quick Tunnel and invalid hostnames before issuing HTTP requests",async()=>{
    const f=fakeFetch();
    await expect(probeNamedOAuthDiscovery("new.trycloudflare.com",f.fn))
      .rejects.toThrow("MCP_NAMED_HOSTNAME_INVALID");
    await expect(probeNamedOAuthDiscovery("MCP.rcity.web.id",f.fn))
      .rejects.toThrow("MCP_NAMED_HOSTNAME_INVALID");
    expect(f.calls).toHaveLength(0);
  });
  it("rejects oversized metadata JSON without trusting the first bytes",async()=>{
    const fn:SafePublicFetch=async(url)=>{
      if(String(url).endsWith("oauth-authorization-server")){
        return new Response(JSON.stringify({...auth,padding:"X".repeat(17_000)}),{
          status:200,headers:{"Content-Type":"application/json"},
        });
      }
      if(String(url).endsWith("oauth-protected-resource/mcp"))return json(resource);
      return new Response(null,{status:401,headers:{
        "WWW-Authenticate":"Bearer",
      }});
    };
    const e=await probeNamedOAuthDiscovery(host,fn);
    expect(e.authorizationServerMetadataVerified).toBe(false);
    expect(e.reasonCodes).toContain("AUTHORIZATION_DISCOVERY_MISMATCH");
    expect(e.readyForCutover).toBe(false);
  });
  it("reports no client authorization after metadata success under any status",async()=>{
    const e=await probeNamedOAuthDiscovery(host,fakeFetch().fn);
    expect(e.metadataOnlyComplete).toBe(true);
    expect(e.geminiClientAuthorized).toBe(false);
    expect(e.cutoverApproved).toBe(false);
    expect(e.readyForCutover).toBe(false);
  });
});
