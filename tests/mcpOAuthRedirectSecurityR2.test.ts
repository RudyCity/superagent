import {describe,expect,it} from "vitest";
import {Readable} from "node:stream";
import type http from "node:http";
import {McpOAuthStore} from "../src/core/mcp/mcpOAuthStore.js";
import {handleOAuthRoute} from "../src/core/mcp/mcpOAuthRoutes.js";
import {isAllowedOAuthRedirectUri} from "../src/core/mcp/mcpOAuthRedirect.js";
const bad=[
 "http://localhost.attacker.invalid/cb",
 "http://127.0.0.1.attacker.invalid/cb",
 "http://127.0.0.1evil.invalid/cb",
 "http://username@localhost/cb",
 "https://user:pass@example.net/cb",
 "https://example.net/cb#fragment",
 "http://example.net/cb",
 "https://example.net\@attacker.invalid/cb",
 "https://example.net/cb\n",
 "javascript:alert(1)",
];
function post(path:string,body:object):http.IncomingMessage{
 const stream=new Readable({read(){this.push(JSON.stringify(body));this.push(null);}}) as unknown as http.IncomingMessage;
 stream.url=path;stream.method="POST";
 stream.headers={"content-type":"application/json"};
 return stream;
}
describe("R2 OAuth redirect and client-registration identity guard",()=>{
 it("rejects all spoofed loopback/credential/fragment redirects",()=>{
  for(const uri of bad){
   expect(isAllowedOAuthRedirectUri(uri),uri).toBe(false);
   expect(()=>new McpOAuthStore().registerClient("test",[uri]),uri).toThrow();
  }
 });
 it("accepts valid secure and actual loopback callbacks",()=>{
  for(const uri of ["https://example.net/cb","http://localhost:1234/cb",
   "http://127.0.0.1:1234/cb","http://[::1]:1244/cb"]){
   expect(isAllowedOAuthRedirectUri(uri),uri).toBe(true);
   expect(()=>new McpOAuthStore().registerClient("test",[uri])).not.toThrow();
  }
 });
 it("rejects spoofed redirect in HTTP dynamic client registration",async()=>{
  const store=new McpOAuthStore();
  for(const uri of bad){
   const r=await handleOAuthRoute(post("/oauth/register",{redirect_uris:[uri]}),{
    store,publicBaseUrl:"https://issuer.example.net",bootstrapCodeHash:"a".repeat(64),
   });
   expect(r.statusCode,uri).toBe(400);
   expect(JSON.parse(r.body).error).toBe("invalid_redirect_uri");
  }
 });
 it("does not let unauthenticated registration overwrite an existing client",async()=>{
  const store=new McpOAuthStore();
  store.registerClient("victim",["https://victim.example.net/callback"]);
  const r=await handleOAuthRoute(post("/oauth/register",{
   client_id:"victim",redirect_uris:["https://attacker.example.net/callback"],
  }),{store,publicBaseUrl:"https://issuer.example.net",bootstrapCodeHash:"a".repeat(64)});
  expect(r.statusCode).toBe(400);
  expect(store.getClient("victim")?.redirectUris).toEqual(["https://victim.example.net/callback"]);
 });
 it("bounds the number of registered callbacks",async()=>{
  const redirects=Array.from({length:17},(_,i)=>"https://client.example.net/callback/"+i);
  expect(()=>new McpOAuthStore().registerClient("many",redirects)).toThrow(/Too many/);
  const r=await handleOAuthRoute(post("/oauth/register",{redirect_uris:redirects}),{
   store:new McpOAuthStore(),publicBaseUrl:"https://issuer.example.net",
   bootstrapCodeHash:"a".repeat(64),
  });
  expect(r.statusCode).toBe(400);
 });
});
