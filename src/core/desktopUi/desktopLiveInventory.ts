/**
 * SuperAgent Tray Desktop Live: operator inventory only.
 * No pixels, browser URL secrets, screenshots, auth tokens or remote-stream endpoints.
 * Stop revokes one previously observed exact handle. It never closes an OS process/tab.
 */
import { nativeWindowPreviewManager } from "./livePreview.js";
import { desktopLiveAccessModes, type DesktopLiveAccessSummary } from "./desktopLiveAccessModes.js";
import { desktopUiSessionManager } from "../tools/desktopUiTools.js";
import { listCdpSessions } from "../tools/chromeCdpSessionManager.js";
import { discoverCdpPages } from "../tools/chromeCdpTools.js";
import { listManagedBrowserRegistrations } from "../tools/managedBrowserRegistry.js";
import { readManagedControlStatus, setManagedBrowserControl } from "../tools/managedBrowserControl.js";
import { delegateBridge } from "../delegate/bridge.js";
import { getBrowserTransport } from "../browserTransport/router.js";
import { listDelegateSessions } from "../browserTransport/sessionCoordinator.js";

export type DesktopLiveKind = "native" | "managed-cdp" | "cdp-delegate" | "lan-device";
export type DesktopLiveItem = {
  id: string; kind: DesktopLiveKind; title: string; application: string;
  handle: string; status: "available" | "controlled" | "human" | "unknown";
  owner?: string; stopAction: "stop-session" | "takeover" | "return-to-agent" | "stop-delegate-tab" | "disconnect-profile" | null;
  access: DesktopLiveAccessSummary;
  impact?: string; revision?: number;
};
const safe = (v:unknown, n=130) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g," ").slice(0,n);
const idNative = (pid:number, nativeId:string) => "native:"+pid+":"+nativeId;
const idManaged = (port:number, targetId:string) => "managed:"+port+":"+targetId;
const idDelegate = (clientId:string, tabId:number) => "delegate:"+clientId+":"+tabId;
const idLan = (deviceId:string) => "lan:"+deviceId;

export async function listDesktopLiveInventory(): Promise<{
  observedAt:number; items:DesktopLiveItem[]; sources:Record<DesktopLiveKind,"ok"|"unavailable">;
}> {
  const items:DesktopLiveItem[] = [];
  const sources:Record<DesktopLiveKind,"ok"|"unavailable"> = {
    native:"unavailable","managed-cdp":"unavailable","cdp-delegate":"unavailable",
    "lan-device":"unavailable",
  };
  try {
    const discovery = await desktopUiSessionManager.listWindows({ limit: 100 });
    const ownerSessions = desktopUiSessionManager.listOperatorSessions();
    const preview = nativeWindowPreviewManager.operatorStatus();
    for (const w of discovery.windows.slice(0,100)) {
      const isPreview = preview?.pid === w.pid && preview.nativeId === w.nativeId;
      const owned = ownerSessions.filter(s => s.pid === w.pid && s.nativeId === w.nativeId);
      items.push({
        id:idNative(w.pid,w.nativeId), kind:"native",title:safe(w.title),
        access:desktopLiveAccessModes("native",{previewActive:isPreview}),
        application:safe(w.application,70),handle:safe(w.nativeId,100),
        status: (isPreview || owned.length) ? "controlled" : "available",
        owner: owned.length ? safe(owned.map(x=>x.owner).join(", "),100) : isPreview ? "Native preview" : undefined,
        stopAction:(isPreview || owned.length)?"stop-session":null,
        impact: "Revoke approved capture/input session only; the app stays open",
      });
    }
    sources.native="ok";
  } catch { /* Explicitly unknown, never invent windows. */ }
  try {
    const sessions = await listCdpSessions();
    const registrations = listManagedBrowserRegistrations();
    const keys = new Map<string,typeof sessions[number]>();
    for (const s of sessions) keys.set(idManaged(s.port,s.targetId),s);
    const ports = [...new Set([...sessions.map(s=>s.port),...registrations.map(r=>r.port)])].slice(0,8);
    for (const port of ports) {
      let targets:Awaited<ReturnType<typeof discoverCdpPages>>=[];
      try { targets = await Promise.race([
        discoverCdpPages(port),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error("timeout")),2500)),
      ]); } catch { /* stale port stays unknown */ }
      const union = new Map<string,{targetId:string;title:string}>();
      for(const t of targets) union.set(t.targetId,{targetId:t.targetId,title:t.title});
      for(const s of sessions.filter(s=>s.port===port)) if(!union.has(s.targetId))
        union.set(s.targetId,{targetId:s.targetId,title:"Target unavailable"});
      for (const t of union.values()) {
        const registration = registrations.find(r=>r.port===port && r.targetId===t.targetId);
        const session = keys.get(idManaged(port,t.targetId));
        let mode:"human"|"agent"|"unknown"="unknown";
        if(registration) try { mode=await readManagedControlStatus(port,t.targetId); }catch{}
        items.push({id:idManaged(port,t.targetId),kind:"managed-cdp",
          access:desktopLiveAccessModes("managed-cdp",{ownerMode:mode}),
          application:"Chrome CDP",title:safe(t.title),handle:safe(t.targetId),
          status:mode==="human"?"human":session?"controlled":mode==="agent"?"available":"unknown",
          owner: session?.agentId ? safe(session.agentId,80) : undefined,
          revision:session?.revision,
          stopAction:registration && session && mode==="agent" ? "takeover" :
            registration && session && mode==="human" ? "return-to-agent" : null,
          impact:"Human takeover blocks agent mutations; browser tab stays open",
        });
      }
    }
    sources["managed-cdp"]="ok";
  } catch {}
  try {
    const clients=delegateBridge.listConnections();
    const sessions=listDelegateSessions();
    for (const client of clients.slice(0,16)) {
      let targets:Awaited<ReturnType<ReturnType<typeof getBrowserTransport>["listTargets"]>> = [];
      try {
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),3000);
        try { targets=await getBrowserTransport("delegate").listTargets(client.clientId,controller.signal); }
        finally {clearTimeout(timer);}
      } catch { /* Online profile still listed below even if CDP discovery unavailable. */ }
      if(!targets.length) {
        items.push({id:"profile:"+client.clientId,kind:"cdp-delegate",title:safe(client.label),
          access:desktopLiveAccessModes("cdp-delegate"),
          application:"Chrome Delegate",handle:safe(client.clientId),status:"unknown",
          stopAction:"disconnect-profile",impact:"Disconnect this entire Chrome Delegate profile; tabs stay open"});
      }
      for(const tab of targets.slice(0,100)) {
        if(!Number.isSafeInteger(tab.tabId)) continue;
        const tabId=Number(tab.tabId);
        const claimed=sessions.find(s=>s.clientId===client.clientId && s.tabId===tabId);
        items.push({id:idDelegate(client.clientId,tabId),kind:"cdp-delegate",
          access:desktopLiveAccessModes("cdp-delegate"),
          title:safe(tab.title||"Untitled tab"),application:safe(client.label,70),
          handle:"Tab "+tab.tabId,status:claimed?"controlled":"available",
          owner:claimed?.agentId?safe(claimed.agentId,70):undefined,
          revision:claimed?.revision,
          stopAction:claimed?"stop-delegate-tab":null,
          impact:"Revoke agent access to only this Delegate tab; Chrome and profile remain connected",
        });
      }
    }
    sources["cdp-delegate"]="ok";
  } catch {}
  try {
    const { listLanDevices } = await import("../lanRemote/controller.js");
    const lanDevices = listLanDevices();
    for (const dev of lanDevices) {
      const isAndroid = dev.platform === "android";
      items.push({
        id: idLan(dev.id),
        kind: "lan-device",
        access: desktopLiveAccessModes("lan-device",{connected:dev.connected}),
        title: safe(dev.label || (isAndroid ? "Android Screen" : "Windows LAN Client Screen")),
        application: safe(isAndroid ? "Android LAN Client" : "Windows LAN Client", 70),
        handle: safe(`${dev.host}:${dev.port} · ${dev.platform.toUpperCase()}`, 100),
        status: dev.connected ? "controlled" : "available",
        owner: dev.transport === "tunnel" ? "Device Tunnel" : "LAN Intranet",
        stopAction: dev.connected ? "stop-session" : null,
        impact: isAndroid ? "Mirror screen of Android device via MediaProjection" : "Mirror screen of secondary Windows LAN client",
      });
    }
    sources["lan-device"]="ok";
  } catch {}
  return {observedAt:Date.now(),items:items.slice(0,256),sources};
}

export async function stopDesktopLiveHandle(
  input:unknown, actor:"human"|"agent", argumentsPrincipal?:string,
):Promise<{stopped:boolean;scope:string;reason:string}> {
  if(!input || typeof input!=="object" || Array.isArray(input))throw Error("INVALID_STOP_REQUEST");
  const b=input as Record<string,unknown>;
  if(Object.keys(b).some(k=>!["id","expectedRevision","confirmProfile","sessionToken"].includes(k)) ||
     typeof b.id!=="string" || b.id.length>210)throw Error("INVALID_STOP_REQUEST");
  const current=await listDesktopLiveInventory();
  const row=current.items.find(x=>x.id===b.id);
  if(!row||!row.stopAction)throw Error("SESSION_NOT_STOPPABLE");
  if(actor==="human" && b.sessionToken!==undefined)throw Error("UNEXPECTED_HUMAN_SESSION_TOKEN");
  if(actor==="agent") {
    const principal = argumentsPrincipal;
    const token = b.sessionToken;
    if(typeof principal!=="string" || !principal.trim() ||
       typeof token!=="string" || !/^[A-Za-z0-9_-]{32,128}$/.test(token))
      throw Error("AGENT_OWNER_CAPABILITY_REQUIRED");
    if(row.kind==="native") {
      const m=/^native:(\d+):(.+)$/.exec(row.id);
      const session=desktopUiSessionManager.getSession(token,principal);
      if(!m || !session || session.target.pid!==Number(m[1]) ||
         session.target.nativeId!==m[2])throw Error("AGENT_NATIVE_SESSION_NOT_OWNED");
      const closed=desktopUiSessionManager.closeSession(token,principal).closed;
      return {stopped:closed,scope:row.id,reason:"Owned agent session revoked; application remains open"};
    }
    if(row.kind==="managed-cdp") {
      const m=/^managed:(\d+):([A-Za-z0-9_-]{1,128})$/.exec(row.id);
      if(!m)throw Error("INVALID_CDP_TARGET");
      const { releaseCdpTarget } = await import("../tools/chromeCdpSessionManager.js");
      await releaseCdpTarget(Number(m[1]),m[2],principal,token);
      return {stopped:true,scope:row.id,reason:"Owned managed CDP session released; tab remains open"};
    }
    if(row.kind==="cdp-delegate" && row.id.startsWith("delegate:")) {
      const m=/^delegate:([A-Za-z0-9_-]{8,80}):(\d+)$/.exec(row.id);
      if(!m)throw Error("INVALID_DELEGATE_TARGET");
      const { releaseDelegateTarget }=await import("../browserTransport/sessionCoordinator.js");
      releaseDelegateTarget(m[1],Number(m[2]),principal,token);
      return {stopped:true,scope:row.id,reason:"Owned Delegate CDP session released; tab remains open"};
    }
    throw Error("AGENT_MAY_NOT_DISCONNECT_ENTIRE_PROFILE");
  }
  if(row.kind==="lan-device" && row.stopAction==="stop-session") {
    if(!/^lan:[A-Za-z0-9_-]{1,128}$/.test(row.id))throw Error("INVALID_LAN_DEVICE");
    const deviceId = row.id.slice(4);
    const { closeLanSession } = await import("../lanRemote/controller.js");
    await closeLanSession(deviceId);
    return { stopped:true,scope:row.id,reason:"LAN session disconnected; device remains connected to its network" };
  }
  if(row.stopAction==="stop-session") {
    const m=/^native:(\d+):(.+)$/.exec(row.id);
    if(!m)throw Error("INVALID_NATIVE_TARGET");
    const pid=Number(m[1]),nativeId=m[2];
    const a=nativeWindowPreviewManager.operatorStop(pid,nativeId);
    const c=desktopUiSessionManager.revokeOperatorWindowSessions(pid,nativeId);
    return {stopped:a||c>0,scope:row.id,reason:"Native session revoked; application not closed"};
  }
  if(row.stopAction==="takeover") {
    if(!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision!==row.revision)
      throw Error("STALE_CDP_REVISION");
    const m=/^managed:(\d+):([A-Za-z0-9_-]{1,128})$/.exec(row.id);
    if(!m)throw Error("INVALID_CDP_TARGET");
    const port=Number(m[1]),targetId=m[2];
    const reg=listManagedBrowserRegistrations().find(r=>r.port===port&&r.targetId===targetId);
    if(!reg)throw Error("UNVERIFIED_CDP_TARGET");
    await setManagedBrowserControl({mode:"human",port,targetId,profileId:reg.profileId,
      generation:reg.generation,browserFingerprint:reg.browserFingerprint},undefined,Number(b.expectedRevision));
    return {stopped:true,scope:row.id,reason:"Agent mutations blocked; browser tab remains open"};
  }
  if(row.stopAction==="return-to-agent") {
    if(row.kind!=="managed-cdp" || row.status!=="human")
      throw Error("MANAGED_CDP_HUMAN_HOLD_REQUIRED");
    if(!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision!==row.revision)
      throw Error("STALE_CDP_REVISION");
    const m=/^managed:(\d+):([A-Za-z0-9_-]{1,128})$/.exec(row.id);
    if(!m)throw Error("INVALID_CDP_TARGET");
    const port=Number(m[1]),targetId=m[2];
    const reg=listManagedBrowserRegistrations().find(r=>r.port===port&&r.targetId===targetId);
    if(!reg)throw Error("UNVERIFIED_CDP_TARGET");
    // The coordination fence refuses return while a takeover reservation
    // remains active; no remote URL, preview token, or fake approval can lift it.
    await setManagedBrowserControl({mode:"agent",port,targetId,profileId:reg.profileId,
      generation:reg.generation,browserFingerprint:reg.browserFingerprint},
      undefined,Number(b.expectedRevision));
    return {stopped:true,scope:row.id,
      reason:"Verified human hold released; managed agent may resume on the same browser target"};
  }
  if(row.stopAction==="stop-delegate-tab") {
    if(!Number.isSafeInteger(b.expectedRevision) || b.expectedRevision!==row.revision)
      throw Error("STALE_DELEGATE_REVISION");
    const m=/^delegate:([A-Za-z0-9_-]{8,80}):(\d+)$/.exec(row.id);
    if(!m)throw Error("INVALID_DELEGATE_TAB");
    const { revokeDelegateTargetByHuman }=await import("../browserTransport/sessionCoordinator.js");
    const stopped=await revokeDelegateTargetByHuman(m[1],Number(m[2]),Number(b.expectedRevision));
    return {stopped,scope:row.id,reason:"Agent claim revoked for this tab; browser stays open"};
  }
  if(row.stopAction==="disconnect-profile") {
    if(b.confirmProfile!==true)throw Error("PROFILE_WIDE_DISCONNECT_REQUIRES_CONFIRMATION");
    const id=row.id.startsWith("profile:")?row.id.slice(8):row.id.slice(9).split(":")[0];
    if(!delegateBridge.listConnections().some(c=>c.clientId===id))throw Error("STALE_DELEGATE_PROFILE");
    const disconnected=delegateBridge.disconnectClient(id);
    return {stopped:disconnected,scope:"profile:"+id,
      reason:"Chrome Delegate profile disconnected; browser tabs stay open"};
  }
  throw Error("UNSUPPORTED_STOP");
}
