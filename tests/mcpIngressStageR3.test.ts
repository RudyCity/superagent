import {describe,it,expect} from "vitest";
import {isPermittedMcpIngressPath,startVerifiedMcpIngress}
 from "../src/core/runtime/mcpIngressStage.js";
describe("R3 ingress owner hard boundary",()=>{
 it("only routes explicit MCP and OAuth endpoints, never owner control or Core",()=>{
   const ok=[["GET","/.well-known/oauth-authorization-server"],
     ["GET","/.well-known/oauth-protected-resource/mcp"],
     ["POST","/oauth/register"],["POST","/oauth/token"],
     ["GET","/oauth/authorize"],["POST","/oauth/authorize"],
     ["POST","/mcp"],["DELETE","/mcp"]];
   for(const [method,path] of ok)
      expect(isPermittedMcpIngressPath(method,path),method+" "+path).toBe(true);
   const bad=[["GET","/_internal/owner/status"],["POST","/_internal/owner/drain"],
     ["GET","/api/status"],["POST","/api/chat"],
     ["POST","/.well-known/oauth-authorization-server"],
     ["GET","/oauth/token"],["GET","/mcp/../_internal/owner/status"],
     ["POST","/mcp%2f../_internal/owner/drain"]];
   for(const [method,path] of bad)
      expect(isPermittedMcpIngressPath(method,path),method+" "+path).toBe(false);
 });
 it("refuses a claimed MCP target without OS listener ownership",async()=>{
   await expect(startVerifiedMcpIngress({
     ingressPort:55211,targetPort:55212,targetPid:99999999,
   })).rejects.toThrow(/not verified/);
   await expect(startVerifiedMcpIngress({
     ingressPort:6789,targetPort:55212,targetPid:1,
   })).rejects.toThrow();
 });
});
