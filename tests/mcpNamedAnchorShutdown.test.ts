import {describe,expect,it} from "vitest";
import crypto from "node:crypto";
import net from "node:net";
import {
  startMcpTunnelAnchor,type McpTunnelAnchorHandle,
} from "../src/core/runtime/mcpTunnelAnchor.js";

async function port():Promise<number>{
  const server=net.createServer();
  return new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      const p=(server.address() as net.AddressInfo).port;
      server.close(()=>resolve(p));
    });
  });
}
const url="https://mcp.rcity.web.id/mcp";
describe("Named Anchor graceful authenticated shutdown",()=>{
  it("rejects unauthenticated, unreviewed, wrong-identity, or unsupported stop",async()=>{
    const p=await port();
    const nonce=crypto.randomBytes(32).toString("hex");
    const createdAt=Date.now();
    const anchor=await startMcpTunnelAnchor({
      port:p,nonce,createdAt,externalNamedHostname:"mcp.rcity.web.id",
    });
    const endpoint="http://127.0.0.1:"+p+"/_internal/anchor/shutdown";
    const payload={reviewed:true,expectedAnchorPid:process.pid,
      expectedPort:p,expectedPublicUrl:url,expectedCurrentOwnerPid:null};
    try{
      const unauthorized=await fetch(endpoint,{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(payload)});
      expect(unauthorized.status).toBe(401);
      const noCallback=await fetch(endpoint,{method:"POST",headers:{
        Authorization:"Bearer "+nonce,"Content-Type":"application/json",
      },body:JSON.stringify(payload)});
      expect(noCallback.status).toBe(409);
      expect((await noCallback.json()).error).toBe("MCP_NAMED_ANCHOR_SHUTDOWN_UNAVAILABLE");
      const status=await fetch("http://127.0.0.1:"+p+"/_internal/anchor/status",{
        headers:{Authorization:"Bearer "+nonce}});
      expect(status.status).toBe(200);
      expect((await status.json()).publicUrl).toBe(url);
    }finally{await anchor.close();}
  });
  it("closes only explicitly reviewed, detached, zero-request Named Anchor",async()=>{
    const p=await port();
    const nonce=crypto.randomBytes(32).toString("hex");
    const createdAt=Date.now();
    let handle:McpTunnelAnchorHandle|undefined;
    let closed=false;
    handle=await startMcpTunnelAnchor({
      port:p,nonce,createdAt,externalNamedHostname:"mcp.rcity.web.id",
      onStopRequested:async()=>{await handle!.close();closed=true;},
    });
    const endpoint="http://127.0.0.1:"+p+"/_internal/anchor/shutdown";
    const control=(data:Record<string,unknown>)=>fetch(endpoint,{
      method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+nonce},
      body:JSON.stringify(data),
    });
    const body={reviewed:true,expectedAnchorPid:process.pid,
      expectedPort:p,expectedPublicUrl:url,expectedCurrentOwnerPid:null};
    try{
      expect((await control({...body,reviewed:false})).status).toBe(409);
      expect((await control({...body,expectedAnchorPid:process.pid+1})).status).toBe(409);
      expect((await control({...body,expectedCurrentOwnerPid:12345})).status).toBe(409);
      expect(closed).toBe(false);
      const approved=await control(body);
      expect(approved.status).toBe(200);
      expect(await approved.json()).toMatchObject({
        accepted:true,anchorPid:process.pid,publicUrl:url,noQuickTunnelMutation:true,
      });
      for(let n=0;n<25&&!closed;n++)
        await new Promise(r=>setTimeout(r,20));
      expect(closed).toBe(true);
    }finally{await handle.close();}
  });
});
