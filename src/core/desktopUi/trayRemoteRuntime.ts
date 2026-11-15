/**
 * Core-owned, explicitly activated remote Tray MANAGEMENT origin.
 * Named uses the operator-configured ingress. Quick launches only a NEW,
 * privately owned cloudflared process for this origin (never MCP/Muse).
 */
import { startRemoteTrayGateway, type RemoteTrayGateway } from "./remoteTrayGateway.js";
import { trayManagementPassword } from "./trayManagementPassword.js";
import { startTrayQuickTunnel, type TrayQuickTunnel } from "./trayQuickTunnel.js";

let active: RemoteTrayGateway | null = null;
let quick: TrayQuickTunnel | null = null;
let pending: Promise<unknown> | null = null;
let pendingAbort: AbortController | null = null;
let activeMode: "named" | "quick" | null = null;

function validPort(port:unknown):port is number {
  return Number.isSafeInteger(port) && Number(port)>=1024 && Number(port)<=65535 &&
    ![7888,9227,6759,6789,9877,17341,19320,19321].includes(Number(port));
}
function requirePort(input:unknown,expectedKeys:string):number {
  if(!input||typeof input!=="object"||Array.isArray(input))throw Error("INVALID_TRAY_REMOTE_REQUEST");
  const o=input as Record<string,unknown>;
  if(Object.keys(o).sort().join(",")!==expectedKeys || !validPort(o.originPort))
    throw Error("INVALID_TRAY_REMOTE_REQUEST");
  return o.originPort;
}
function claimStart():AbortController {
  if(active||pending)throw Error("TRAY_REMOTE_ALREADY_ACTIVE");
  const abort=new AbortController();
  pendingAbort=abort;
  return abort;
}
async function finishStart<T>(work:Promise<T>):Promise<T> {
  pending=work;
  try {return await work;}
  finally {if(pending===work){pending=null;pendingAbort=null;}}
}
export function trayRemoteStatus() {
  return {
    configured: trayManagementPassword.status().configured,
    active: !!active,
    mode: activeMode,
    connecting: !!pending,
    publicUrl: active?.publicUrl || null,
    originPort: active?.originPort ?? null,
    connectorReady: !!quick && !!active,
    routeVerified: false,
    note: activeMode==="quick"
      ? "Tray-only Quick Tunnel URL is temporary. HTTPS edge reachability is not independently verified."
      : active
        ? "Local management origin active. Public Named Tunnel routing/DNS is not verified."
        : pending
          ? "Starting password-protected Tray Quick Tunnel. No screen streaming is exposed."
          : "Remote Tray gateway is inactive; host approval required.",
  };
}
export async function startTrayRemoteManagement(input:unknown) {
  const port=requirePort(input,"originPort,publicOrigin");
  const origin=(input as Record<string,unknown>).publicOrigin;
  if(typeof origin!=="string")throw Error("DEDICATED_NAMED_HOSTNAME_REQUIRED");
  let host:URL;
  try{host=new URL(origin);}catch{throw Error("INVALID_REMOTE_HOSTNAME");}
  if(host.protocol!=="https:"||host.origin!==origin||
     (host.hostname==="localhost"||[".trycloudflare.com",".cfargotunnel.com",".example.test"]
       .some(suffix=>host.hostname.endsWith(suffix))))
    throw Error("DEDICATED_NAMED_HOSTNAME_REQUIRED");
  const abort=claimStart();
  return finishStart((async()=>{
    const gateway=await startRemoteTrayGateway({publicOrigin:origin,originPort:port,passwordStore:trayManagementPassword});
    if(abort.signal.aborted){await gateway.close();throw Error("TRAY_REMOTE_CANCELLED");}
    active=gateway;activeMode="named";
    return trayRemoteStatus();
  })());
}
export async function startTrayQuickManagement(input:unknown) {
  const port=requirePort(input,"originPort");
  const abort=claimStart();
  return finishStart((async()=>{
    const gateway=await startRemoteTrayGateway({
      publicOrigin:"",originPort:port,passwordStore:trayManagementPassword,mode:"quick",
    });
    let tunnel:TrayQuickTunnel|null=null;
    try {
      if(abort.signal.aborted)throw Error("TRAY_QUICK_CANCELLED");
      tunnel=await startTrayQuickTunnel({
        originPort:gateway.originPort,
        signal:abort.signal,
        onExit:()=>{if(active===gateway)void stopTrayRemoteManagement();},
      });
      if(abort.signal.aborted)throw Error("TRAY_QUICK_CANCELLED");
      gateway.activateQuickOrigin(tunnel.publicUrl);
      active=gateway;quick=tunnel;activeMode="quick";
      return trayRemoteStatus();
    }catch(err){
      if(tunnel)await tunnel.stop();
      await gateway.close();
      throw err;
    }
  })());
}
export async function stopTrayRemoteManagement() {
  pendingAbort?.abort();
  if(pending){try{await pending;}catch{}}
  const gateway=active;
  const tunnel=quick;
  active=null;quick=null;activeMode=null;
  // Close management access before signaling the only owned cloudflared child.
  if(gateway)await gateway.close();
  if(tunnel)await tunnel.stop();
  return trayRemoteStatus();
}
