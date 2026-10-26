import {describe,expect,it} from "vitest";
import {assessPublicIssuerParity} from "../src/core/runtime/mcpPublicIssuerParityR3.js";
const issuer="https://mcp.example.net";
const good={
 expectedPublicIssuer:issuer,
 authorizationServer:{
  issuer,authorization_endpoint:issuer+"/oauth/authorize",
  token_endpoint:issuer+"/oauth/token",
  registration_endpoint:issuer+"/oauth/register",
  code_challenge_methods_supported:["S256"],
  grant_types_supported:["authorization_code","refresh_token"],
  resource_indicators_supported:true,
 },
 protectedResource:{resource:issuer+"/mcp",authorization_servers:[issuer]},
};
describe("R3 exact public ingress issuer/resource parity",()=>{
 it("can only mark exact metadata as a review candidate",()=>{
  const d=assessPublicIssuerParity(good);
  expect(d.status).toBe("metadata_review_candidate");
  expect(d.blockers).toHaveLength(0);
  expect(d.liveRoutingAllowed).toBe(false);
 });
 it("blocks an isolated staging issuer on loopback",()=>{
  expect(assessPublicIssuerParity({...good,
   expectedPublicIssuer:"http://127.0.0.1:55110"})
   .blockers).toContain("INVALID_PUBLIC_ISSUER");
 });
 it("blocks any live metadata still advertising the backend issuer",()=>{
  const a=assessPublicIssuerParity({...good,
   authorizationServer:{...good.authorizationServer,issuer:"http://127.0.0.1:55110"},
   protectedResource:{resource:"http://127.0.0.1:55110/mcp",
     authorization_servers:["http://127.0.0.1:55110"]}});
  expect(a.blockers).toContain("ISSUER_IDENTITY_MISMATCH");
  expect(a.blockers).toContain("PROTECTED_RESOURCE_IDENTITY_MISMATCH");
 });
 it("rejects misrouted endpoint and stripped PKCE/S256",()=>{
  const a=assessPublicIssuerParity({...good,
   authorizationServer:{...good.authorizationServer,
     token_endpoint:"https://attacker.invalid/oauth/token",
     code_challenge_methods_supported:["plain"]}});
  expect(a.blockers).toContain("OAUTH_ENDPOINT_PARITY_TOKEN_ENDPOINT");
  expect(a.blockers).toContain("PKCE_S256_NOT_ADVERTISED");
 });
 it("blocks missing discovery metadata, resource mismatch and extra issuers",()=>{
  expect(assessPublicIssuerParity({...good,authorizationServer:null})
   .blockers).toContain("DISCOVERY_RESPONSES_MISSING");
  expect(assessPublicIssuerParity({...good,protectedResource:{
   resource:issuer+"/mcp",authorization_servers:[issuer,"https://other.example.net"]}})
   .blockers).toContain("PROTECTED_RESOURCE_ISSUER_MISMATCH");
 });
 it("rejects http, private and embedded-credential URLs",()=>{
  for(const url of ["http://mcp.example.net","https://localhost",
   "https://127.0.0.1","https://[::1]","https://admin:pass@mcp.example.net",
   "https://mcp.example.net/path","https://mcp.example.net?x=1"]){
   expect(assessPublicIssuerParity({...good,expectedPublicIssuer:url})
    .status).toBe("blocked");
  }
 });
});
