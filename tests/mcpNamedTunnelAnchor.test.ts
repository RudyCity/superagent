import {describe,expect,it,vi} from "vitest";
import crypto from "node:crypto";
import net from "node:net";

const mock=vi.hoisted(()=>({
  startQuickTunnel:vi.fn(async()=>({publicUrl:"https://wrong.trycloudflare.com",pid:10101})),
  stopQuickTunnel:vi.fn(async()=>true),
  getTunnelStatus:vi.fn(()=>({isRunning:false})),
}));
vi.mock("../src/core/remoteAgent/cloudflareTunnel.js",async get=>{
  const orig=await get<typeof import("../src/core/remoteAgent/cloudflareTunnel.js")>();
  return {...orig,...mock};
});
import {startMcpTunnelAnchor} from "../src/core/runtime/mcpTunnelAnchor.js";
function freePort():Promise<number>{
  const server=net.createServer();
  return new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      const port=(server.address() as net.AddressInfo).port;
      server.close(()=>resolve(port));
    });
  });
}
describe("Named external connector / Anchor isolation",()=>{
  it("binds only loopback and leaves Cloudflare, DNS and tokens untouched",async()=>{
    mock.startQuickTunnel.mockClear();
    mock.stopQuickTunnel.mockClear();
    const port=await freePort();
    const nonce=crypto.randomBytes(32).toString("hex");
    const anchor=await startMcpTunnelAnchor({
      port,nonce,
      createdAt:Date.now(),externalNamedHostname:"mcp.example.org",
    });
    try{
      expect(anchor.publicUrl).toBe("https://mcp.example.org/mcp");
      const privateStatus=await fetch("http://127.0.0.1:"+port+"/_internal/anchor/status",{
        headers:{Authorization:"Bearer invalid"},
      });
      expect(privateStatus.status).toBe(401);
      const verified=await fetch("http://127.0.0.1:"+port+"/_internal/anchor/status",{
        headers:{Authorization:"Bearer "+nonce},
      });
      expect(await verified.json()).toMatchObject({
        tunnelMode:"named-external",externalConnectorVerified:false,
        tunnelPid:null,quickTunnelUrlNotRecoverable:false,
        publicUrl:"https://mcp.example.org/mcp",
      });
      const res=await fetch("http://127.0.0.1:"+port+"/mcp");
      expect(res.status).toBe(503);
      expect(mock.startQuickTunnel).not.toHaveBeenCalled();
      expect(mock.stopQuickTunnel).not.toHaveBeenCalled();
    }finally{await anchor.close();}
    expect(mock.startQuickTunnel).not.toHaveBeenCalled();
    expect(mock.stopQuickTunnel).not.toHaveBeenCalled();
  },15_000);
  it("never accepts injected named-tunnel launch dependencies",async()=>{
    const port=await freePort();
    await expect(startMcpTunnelAnchor({
      port,nonce:crypto.randomBytes(32).toString("hex"),
      createdAt:Date.now(),externalNamedHostname:"mcp.example.org",
    },{startTunnel:async()=>({publicUrl:"https://wrong.trycloudflare.com"})}))
      .rejects.toThrow("MCP_NAMED_ANCHOR_EXTERNAL_CONNECTOR_ONLY");
  });
});
