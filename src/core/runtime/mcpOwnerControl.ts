/**
 * R1 private MCP owner attestation / drain client. Does not use the public
 * MCP client bearer. Same-user staging nonce is a local coordination secret,
 * not a Windows security privilege boundary.
 */
import http from "node:http";
import type { ManagedMcpLease } from "./mcpOwnerStagingLease.js";

export interface PrivateMcpOwnerStatus {
  version:1;kind:"private_mcp_owner";
  pid:number;port:number;startedAt:number;
  mode:"static-bearer-local";
  activeSessions:number;inFlightRequests:number;draining:boolean;
  inflightToolEffects:"unknown";
  safeToolsOnly:true;oauthEnabled:false;publicTunnelStarted:false;
}
export async function probePrivateMcpOwner(
  lease:ManagedMcpLease,
  operation:"status"|"drain"="status",
):Promise<PrivateMcpOwnerStatus|null>{
  if(!/^[a-f0-9]{64}$/.test(lease.nonce)||
     !Number.isSafeInteger(lease.createdAt)||lease.createdAt<=0)
    return null;
  return await new Promise(resolve=>{
    let completed=false;
    const finish=(value:PrivateMcpOwnerStatus|null)=>{
      if(completed)return;
      completed=true;resolve(value);
    };
    const req=http.request({
      hostname:"127.0.0.1",port:lease.port,
      path:"/_internal/owner/"+operation,
      method:operation==="status"?"GET":"POST",timeout:1600,
      headers:{Authorization:"Bearer "+lease.nonce,
        Accept:"application/json",Host:"127.0.0.1:"+lease.port},
    },res=>{
      let response="";
      res.setEncoding("utf8");
      res.on("data",chunk=>{
        response+=chunk;
        if(response.length>2048){req.destroy();finish(null);}
      });
      res.once("end",()=>{
        try{
          if(res.statusCode!==200)return finish(null);
          const body=JSON.parse(response) as Record<string,unknown>;
          if(body.version!==1||body.kind!=="private_mcp_owner"||
             body.pid!==lease.pid||body.port!==lease.port||
             body.startedAt!==lease.createdAt||
             body.mode!=="static-bearer-local"||
             !Number.isSafeInteger(body.activeSessions)||
             Number(body.activeSessions)<0||Number(body.activeSessions)>100000||
             !Number.isSafeInteger(body.inFlightRequests)||
             Number(body.inFlightRequests)<0||Number(body.inFlightRequests)>100000||
             typeof body.draining!=="boolean"||
             body.inflightToolEffects!=="unknown"||
             body.safeToolsOnly!==true||body.oauthEnabled!==false||
             body.publicTunnelStarted!==false)return finish(null);
          finish(body as unknown as PrivateMcpOwnerStatus);
        }catch{finish(null);}
      });
    });
    req.on("timeout",()=>req.destroy());
    req.on("error",()=>finish(null));
    req.end();
  });
}
