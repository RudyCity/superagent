/**
 * Explicit Core-owned Tray management origin. Never an autonomous service.
 * A local, authenticated native Tray operator must start it with exact HTTPS
 * hostname and unprotected local origin port. No cloudflared/DNS changes here.
 */
import { startRemoteTrayGateway, type RemoteTrayGateway } from "./remoteTrayGateway.js";
import { trayManagementPassword } from "./trayManagementPassword.js";

let active: RemoteTrayGateway | null = null;
export function trayRemoteStatus() {
  return {
    configured: trayManagementPassword.status().configured,
    active: !!active,
    publicUrl: active?.publicUrl ?? null,
    originPort: active?.originPort ?? null,
    routeVerified: false,
    note: active
      ? "Local management origin active. Public Named Tunnel routing/DNS is not verified."
      : "Remote Tray gateway is inactive; host approval required.",
  };
}
export async function startTrayRemoteManagement(input:unknown) {
  if(!input||typeof input!=="object"||Array.isArray(input))throw Error("INVALID_TRAY_REMOTE_REQUEST");
  const o=input as Record<string,unknown>;
  if(Object.keys(o).sort().join(",")!=="originPort,publicOrigin" ||
     typeof o.publicOrigin!=="string" ||
     !Number.isSafeInteger(o.originPort) || Number(o.originPort)<1024 || Number(o.originPort)>65535 ||
     [7888,9227,6759,6789,9877,17341,19320,19321].includes(Number(o.originPort)) ||
     active)throw Error("TRAY_REMOTE_ALREADY_ACTIVE_OR_INVALID");
  const origin=o.publicOrigin;
  let host:URL;
  try{host=new URL(origin);}catch{throw Error("INVALID_REMOTE_HOSTNAME");}
  if(host.protocol!=="https:" || host.origin!==origin ||
     /(?:^|\.)(?:localhost|trycloudflare\.com|cfargotunnel\.com|example\.test)$/.test(host.hostname))
    throw Error("DEDICATED_NAMED_HOSTNAME_REQUIRED");
  active=await startRemoteTrayGateway({
    publicOrigin:origin,
    originPort:Number(o.originPort),
    passwordStore:trayManagementPassword,
  });
  return trayRemoteStatus();
}
export async function stopTrayRemoteManagement() {
  const gateway=active;
  active=null;
  if(gateway)await gateway.close();
  return trayRemoteStatus();
}
