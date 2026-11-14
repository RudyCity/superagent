import {describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {spawn} from "node:child_process";

async function freePort():Promise<number>{
  const server=net.createServer();
  return new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      const port=(server.address() as net.AddressInfo).port;
      server.close(()=>resolve(port));
    });
  });
}
describe("Remote-managed Named Tunnel independent Anchor CLI",()=>{
  it("starts only a fixed-hostname local Anchor, without creating cloudflared or touching live MCP",async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"remote-anchor-cli-"));
    const port=await freePort(),ownerPort=await freePort();
    const id="b2e8c6d9-9317-4d9e-b381-826af22e1778";
    const tokenPath=path.join(root,"private","cloudflare-named",
      "b2e8c6d9-9317-4d9e-b381-826af22e1778.token");
    fs.mkdirSync(path.dirname(tokenPath),{recursive:true});
    const binary=path.join(root,process.platform==="win32"?"cloudflared.exe":"cloudflared");
    fs.writeFileSync(tokenPath,Buffer.from(JSON.stringify({
      a:"isolated-account",t:id,s:"isolated-test-secret",
    })).toString("base64url"));
    fs.writeFileSync(binary,"isolated fixture, never executed");
    fs.writeFileSync(path.join(root,"mcp-named-tunnel-settings.json"),JSON.stringify({
      version:1,connectorMode:"remote-managed",
      tunnelId:id,hostname:"mcp.rcity.web.id",
      anchorPort:port,ownerPort,tokenFilePath:tokenPath,
      credentialsFilePath:"",cloudflaredPath:binary,
    }));
    const child=spawn(process.execPath,[
      "scripts/mcp-tunnel-anchor.ts","start-profile",String(port),"--reviewed",
    ],{
      cwd:process.cwd(),env:{...process.env,SUPERAGENT_CONFIG_DIR:root},
      stdio:["ignore","pipe","pipe"],windowsHide:true,
    });
    let out="",errors="";
    child.stdout?.on("data",b=>{out+=b.toString();});
    child.stderr?.on("data",b=>{errors+=b.toString().slice(0,500);});
    try{
      let state:any=null;
      for(let i=0;i<75;i++){
        if(child.exitCode!==null)break;
        const f=path.join(root,"mcp-tunnel-anchor-"+port+".json");
        if(fs.existsSync(f)){
          const lease=JSON.parse(fs.readFileSync(f,"utf8"));
          if(lease.port===port){
            const response=await fetch("http://127.0.0.1:"+port+"/_internal/anchor/status",{
              headers:{Authorization:"Bearer "+lease.nonce},
              signal:AbortSignal.timeout(1000),
            }).catch(()=>null);
            if(response?.ok){state=await response.json();break;}
          }
        }
        await new Promise(r=>setTimeout(r,120));
      }
      expect(state,errors).not.toBeNull();
      expect(state).toMatchObject({
        port,publicUrl:"https://mcp.rcity.web.id/mcp",
        tunnelMode:"named-external",tunnelPid:null,
        ready:false,externalConnectorVerified:false,
      });
      expect(out).toContain('"tunnelMode": "named-external"');
      expect(errors).not.toContain("Quick Tunnel");
      // Exercise the real child-process callback/lease cleanup, not just the
      // in-process Anchor handler; no cloudflared process is created.
      const leasePath=path.join(root,"mcp-tunnel-anchor-"+port+".json");
      const lease=JSON.parse(fs.readFileSync(leasePath,"utf8"));
      const stopped=await fetch("http://127.0.0.1:"+port+"/_internal/anchor/shutdown",{
        method:"POST",headers:{Authorization:"Bearer "+lease.nonce,
          "Content-Type":"application/json"},
        body:JSON.stringify({reviewed:true,expectedAnchorPid:lease.pid,
          expectedPort:port,expectedPublicUrl:"https://mcp.rcity.web.id/mcp",
          expectedCurrentOwnerPid:null}),
      });
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toMatchObject({accepted:true,noQuickTunnelMutation:true});
      for(let i=0;i<40&&child.exitCode===null;i++)
        await new Promise(r=>setTimeout(r,100));
      expect(child.exitCode).toBe(0);
      expect(fs.existsSync(leasePath)).toBe(false);
    }finally{
      if(child.exitCode===null){
        child.kill();
        await Promise.race([
          new Promise<void>(r=>child.once("exit",()=>r())),
          new Promise<void>(r=>setTimeout(r,1500)),
        ]);
      }
      fs.rmSync(root,{recursive:true,force:true});
    }
  },30_000);
});
