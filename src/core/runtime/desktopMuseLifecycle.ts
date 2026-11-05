/**
 * Core-local Muse Watch lifecycle.
 *
 * Start is explicit and transport-scoped. Stop/restart never kill arbitrary
 * PIDs or replay remote tasks. apply-restart drains an idle watcher, rebuilds
 * it from the latest persisted Muse config, and attempts to restore the old
 * watcher if the replacement cannot start.
 */
import fs from "node:fs";
import path from "node:path";
import type { MuseWatcher } from "../remoteAgent/museWatcher.js";

type MuseLifecycleAction = "start" | "stop" | "restart" | "apply-restart";
export type MuseStartMode = "telegram" | "websocket" | "tunnel";
type Watcher = Pick<MuseWatcher, "getStats" | "isActive" | "hasActiveBatch" | "stop" | "start">;

export async function transitionCoreMuseWatcher(
  watcher: Watcher | null, action: "stop" | "restart",
): Promise<{success:true; action:"stop"|"restart"; state:"stopped"|"running"}> {
  if (!watcher) throw new Error("No Core-owned Muse Watch instance is registered");
  const stats = watcher.getStats();
  if (stats.activeTaskId || (stats.queuedBatches ?? 0) > 0 || watcher.hasActiveBatch()) {
    throw new Error("Muse has an active or queued batch. Stop/restart rejected; no task was aborted or replayed");
  }
  if (action === "stop") {
    if (!watcher.isActive()) throw new Error("Muse Watch is already stopped");
    await watcher.stop();
    return {success:true, action, state:"stopped"};
  }
  if (stats.tunnel) {
    throw new Error("Muse owns a public tunnel. Restart here could change its URL; use the tunnel migration flow");
  }
  if (watcher.isActive()) await watcher.stop();
  await watcher.start();
  return {success:true, action, state:"running"};
}

async function validateWorkspaces() {
  const {loadRemoteAgentConfig,getWatchedWorkspaces}=await import("../remoteAgent/config.js");
  const cfg=loadRemoteAgentConfig();
  const workspaces=getWatchedWorkspaces(cfg).map(value=>path.resolve(value));
  if (!workspaces.length || workspaces.some(value =>
    !fs.existsSync(value) || !fs.statSync(value).isDirectory())) {
    throw new Error("Configure at least one valid Muse watched workspace first");
  }
  return {cfg,workspaces};
}

async function startConfiguredMuse(
  mode:MuseStartMode,
  portOverride?:number,
):Promise<{
  success:true;action:"start";state:"running";mode:MuseStartMode;
  port?:number;setupCopied?:boolean;message:string;
}> {
  const {getMuseWatcher,startMuseWatcher}=await import("../remoteAgent/museWatcherRegistry.js");
  if(getMuseWatcher()?.isActive())
    throw new Error("Muse Watch is already running; stop it before switching transport");

  const {getActiveRemoteTaskId}=await import("../remoteAgent/taskRunner.js");
  if(getActiveRemoteTaskId())
    throw new Error("Remote task is active. Muse Watch start rejected; no task was interrupted");

  const {cfg,workspaces}=await validateWorkspaces();

  if(mode==="tunnel"){
    const port=portOverride??cfg.wsPort??9225;
    const {createTrayConnection}=await import("./trayConnectionCreation.js");
    const result=await createTrayConnection({kind:"muse-tunnel",port});
    return {
      success:true,action:"start",state:"running",mode,port,
      setupCopied:result.setupCopied===true,
      message:String(result.message||"Muse Watch tunnel started"),
    };
  }

  if(mode==="telegram"){
    if(!cfg.botToken||cfg.groupId===undefined||cfg.museBotId===undefined)
      throw new Error("Telegram Muse configuration is incomplete (bot token, group ID, or Muse bot ID missing)");
    const watcher=await startMuseWatcher({
      workspace:workspaces[0],workspaces,transportType:"telegram",
      autoApproveWorkspace:false,announce:false,skipRemoteTaskAbort:true,
    });
    if(!watcher.isActive()) throw new Error("Telegram Muse Watch did not become active");
    return {success:true,action:"start",state:"running",mode,
      message:"Muse Watch started in Telegram mode"};
  }

  const {
    generateSecureWsToken,
    updateRemoteAgentConfig,
  }=await import("../remoteAgent/config.js");
  const port=portOverride??cfg.wsPort??9225;
  if(!Number.isSafeInteger(port)||port<1024||port>65535||
     [7888,7891,7892,9227].includes(port))
    throw new Error("Invalid or reserved Muse WebSocket port");

  const wsMode=cfg.wsMode==="client"?"client":"server";
  let token=cfg.wsToken;
  if(wsMode==="server"&&!token){
    token=generateSecureWsToken();
    updateRemoteAgentConfig({wsToken:token});
  }
  if(wsMode==="client"&&!cfg.wsRemoteUrl)
    throw new Error("Muse WebSocket client mode requires a configured remote URL");
  if(wsMode==="client"&&!token&&!cfg.cfAccessClientId)
    throw new Error("Muse WebSocket client mode requires a bearer token or Cloudflare Access credential");

  updateRemoteAgentConfig({
    transport:"websocket",
    wsPort:port,
    wsHost:"127.0.0.1",
    wsPath:cfg.wsPath||"/muse",
  });

  const watcher=await startMuseWatcher({
    workspace:workspaces[0],workspaces,transportType:"websocket",wsPort:port,
    autoApproveWorkspace:false,announce:false,skipRemoteTaskAbort:true,
  });
  if(!watcher.isActive()) throw new Error("WebSocket Muse Watch did not become active");

  if(wsMode==="client"){
    return {success:true,action:"start",state:"running",mode,port,
      message:"Muse Watch started in WebSocket client mode"};
  }

  const {copyTextToClipboard}=await import("../remoteAgent/cloudflareTunnel.js");
  const setupCopied=await copyTextToClipboard(
    "Muse WebSocket local connection\n"+
    "URL: ws://127.0.0.1:"+port+(cfg.wsPath||"/muse")+"\n"+
    "Authorization: Bearer "+token
  );
  return {
    success:true,action:"start",state:"running",mode,port,setupCopied,
    message:setupCopied
      ?"Muse Watch started in WebSocket server mode; private local connection copied to clipboard"
      :"Muse Watch started in WebSocket server mode; clipboard copy was unavailable",
  };
}

let lifecycleInProgress = false;

export async function controlCoreLocalMuse(
  action:string,
  expectedPid:number,
  options:{mode?:MuseStartMode;port?:number}={},
):Promise<{
  success:true;
  action:MuseLifecycleAction;
  state:"stopped"|"running";
  mode?:MuseStartMode;
  port?:number;
  setupCopied?:boolean;
  message?:string;
}> {
  if(expectedPid!==process.pid)
    throw new Error("Owner PID mismatch; Muse lifecycle was not touched");
  if(!["start","stop","restart","apply-restart"].includes(action))
    throw new Error("Unsupported Muse lifecycle action");
  if(lifecycleInProgress) throw new Error("Muse lifecycle change already in progress");

  lifecycleInProgress=true;
  try{
    const {getMuseWatcher}=await import("../remoteAgent/museWatcherRegistry.js");

    if(action==="stop"||action==="restart")
      return await transitionCoreMuseWatcher(getMuseWatcher(),action);

    if(action==="apply-restart"){
      const watcher=getMuseWatcher();
      if(!watcher||!watcher.isActive()) throw new Error("Muse Watch is not running");
      const stats=watcher.getStats();
      if(stats.activeTaskId||(stats.queuedBatches??0)>0||watcher.hasActiveBatch())
        throw new Error("Muse has an active or queued batch. Apply & Restart rejected");
      if(stats.tunnel)
        throw new Error("Muse owns a public tunnel. Apply & Restart cannot rotate or recreate its URL");
      const mode:MuseStartMode=stats.transport==="telegram"
        ?"telegram":stats.transport==="websocket"?"websocket":
        (()=>{throw new Error("Current Muse transport cannot be rebuilt from Tray")})();
      await watcher.stop();
      try{
        const replacement=await startConfiguredMuse(mode,undefined);
        return {...replacement,action:"apply-restart",
          message:"Muse settings applied and watcher restarted with the latest configuration"};
      }catch(error){
        try{await watcher.start()}catch{}
        throw error;
      }
    }

    const mode=options.mode;
    if(!mode||!["telegram","websocket","tunnel"].includes(mode))
      throw new Error("Select Telegram, WebSocket, or WebSocket + Tunnel");
    // UI/native requests select the transport only; persisted Muse settings
    // remain the single source of truth for WebSocket port/path/mode.
    return await startConfiguredMuse(mode,undefined);
  }finally{
    lifecycleInProgress=false;
  }
}
