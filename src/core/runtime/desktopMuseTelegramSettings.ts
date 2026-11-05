/**
 * Authenticated local Tray settings bridge for Muse.
 *
 * Secret values are write-only from the WebView perspective. The Telegram bot
 * token is migrated to an OS-protected secret reference on Windows (DPAPI
 * CurrentUser) and is never returned in API responses.
 */
import fs from "node:fs";
import path from "node:path";
import {
  getMuseRuntimeConfigRevision,
  getMuseTelegramSecretStorage,
  getWatchedWorkspaces,
  loadRemoteAgentConfig,
  maskToken,
  migrateMuseTelegramBotTokenToSecureStorage,
  setMuseTelegramBotTokenSecure,
  updateRemoteAgentConfig,
} from "../remoteAgent/config.js";
import { MuseClient } from "../remoteAgent/museClient.js";
import { getMuseWatcher } from "../remoteAgent/museWatcherRegistry.js";
import { inspectTelegramPollingOwner } from "../remoteAgent/telegramPollingLease.js";

export type MuseSettingsView = {
  tokenConfigured:boolean;
  tokenMask:string;
  tokenStorage:string;
  tokenPlatformProtected:boolean;
  groupId:string;
  museBotId:string;
  telegramReady:boolean;
  workspaces:string[];
  defaultWorkspace:string;
  wsPort:number;
  wsPath:string;
  wsMode:"server"|"client";
  wsRemoteUrl:string;
  wsTokenConfigured:boolean;
  autoStartMode:"off"|"telegram"|"websocket";
  watcherActive:boolean;
  watcherTransport:string|null;
  configStale:boolean;
  configRevision:string;
  watcherConfigRevision:string|null;
  pollingOwnerPid:number|null;
  pollingOwnerConflict:boolean;
  ready:boolean;
};

export type MuseSettingsUpdate = {
  botToken:string;
  groupId:string;
  museBotId:string;
  clearBotToken:boolean;
  workspaces:string[];
  defaultWorkspace:string;
  wsPort:number;
  wsPath:string;
  wsMode:"server"|"client";
  wsRemoteUrl:string;
  autoStartMode:"off"|"telegram"|"websocket";
};

function record(raw:unknown):Record<string,unknown>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw new Error("Muse settings must be an object");
  return raw as Record<string,unknown>;
}
function exactKeys(obj:Record<string,unknown>,allowed:string[]){
  const a=Object.keys(obj).sort(),b=[...allowed].sort();
  if(a.length!==b.length||b.some((key,i)=>key!==a[i]))
    throw new Error("Unexpected or missing Muse setting");
}
function normalizeId(value:unknown,field:string,allowNegative:boolean){
  const text=String(value??"").trim();
  const pattern=allowNegative?/^-?[0-9]{1,20}$/:/^[0-9]{1,20}$/;
  if(text&&!pattern.test(text)) throw new Error(field+" must be a numeric Telegram ID");
  return text;
}
function normalizeToken(value:unknown){
  const text=String(value??"").trim();
  if(!text)return "";
  if(text.length>256||!/^[0-9]{5,20}:[A-Za-z0-9_-]{20,180}$/.test(text))
    throw new Error("Telegram bot token format is invalid");
  return text;
}
function normalizeWorkspaces(value:unknown){
  if(!Array.isArray(value)||value.length<1||value.length>32)
    throw new Error("Configure between 1 and 32 watched workspaces");
  const out:string[]=[];
  const seen=new Set<string>();
  for(const item of value){
    const raw=String(item??"").trim();
    if(!raw||raw.length>500||!path.isAbsolute(raw))
      throw new Error("Watched workspaces must be absolute local paths");
    const resolved=path.resolve(raw);
    if(!fs.existsSync(resolved)||!fs.statSync(resolved).isDirectory())
      throw new Error("Watched workspace does not exist or is not a directory: "+path.basename(resolved));
    const key=process.platform==="win32"?resolved.toLowerCase():resolved;
    if(!seen.has(key)){seen.add(key);out.push(resolved);}
  }
  return out;
}
function normalizeWsPath(value:unknown){
  const text=String(value??"/muse").trim()||"/muse";
  if(text.length>96||!/^\/[A-Za-z0-9/_-]*$/.test(text)||text.includes("//"))
    throw new Error("Muse WebSocket path must be a simple absolute path");
  return text;
}
function normalizeWsRemoteUrl(value:unknown,mode:"server"|"client"){
  const text=String(value??"").trim();
  if(mode==="server") return "";
  if(!text) throw new Error("WebSocket client mode requires a remote ws:// or wss:// URL");
  let url:URL;
  try{url=new URL(text)}catch{throw new Error("Muse WebSocket remote URL is invalid")}
  if(!["ws:","wss:"].includes(url.protocol)||url.username||url.password||url.hash)
    throw new Error("Muse WebSocket remote URL must use ws:// or wss:// without embedded credentials");
  return url.toString();
}

async function buildView():Promise<MuseSettingsView>{
  const cfg=loadRemoteAgentConfig();
  const watcher=getMuseWatcher();
  const stats=watcher?.getStats();
  const currentRevision=getMuseRuntimeConfigRevision(cfg);
  const storage=getMuseTelegramSecretStorage();
  const polling=cfg.botToken
    ? await inspectTelegramPollingOwner(cfg.botToken).catch(()=>({active:false} as any))
    : {active:false} as any;
  const workspaces=getWatchedWorkspaces(cfg);
  const telegramReady=Boolean(cfg.botToken&&cfg.groupId!==undefined&&cfg.groupId!==""&&
    cfg.museBotId!==undefined&&cfg.museBotId!=="");
  const wsMode=cfg.wsMode==="client"?"client":"server";
  const wsReady=Boolean(cfg.wsToken&&(wsMode==="server"||cfg.wsRemoteUrl));
  return {
    tokenConfigured:Boolean(cfg.botToken),
    tokenMask:cfg.botToken?maskToken(cfg.botToken):"",
    tokenStorage:String(storage.storage||"none"),
    tokenPlatformProtected:storage.platformProtected===true,
    groupId:cfg.groupId===undefined?"":String(cfg.groupId),
    museBotId:cfg.museBotId===undefined?"":String(cfg.museBotId),
    telegramReady,
    workspaces,
    defaultWorkspace:cfg.defaultWorkspace||workspaces[0]||"",
    wsPort:Number(cfg.wsPort||9225),
    wsPath:cfg.wsPath||"/muse",
    wsMode,
    wsRemoteUrl:cfg.wsRemoteUrl||"",
    wsTokenConfigured:Boolean(cfg.wsToken),
    autoStartMode:cfg.museAutoStartMode||"off",
    watcherActive:Boolean(watcher?.isActive()),
    watcherTransport:stats?.transport||null,
    configStale:Boolean(watcher?.isActive()&&stats?.configRevision&&stats.configRevision!==currentRevision),
    configRevision:currentRevision,
    watcherConfigRevision:stats?.configRevision||null,
    pollingOwnerPid:polling.active?Number(polling.pid||0)||null:null,
    pollingOwnerConflict:Boolean(polling.active&&polling.pid!==process.pid),
    ready:telegramReady||wsReady,
  };
}

export async function readMuseTelegramSettings():Promise<MuseSettingsView>{
  return await buildView();
}

export async function updateMuseTelegramSettings(raw:unknown):Promise<MuseSettingsView>{
  const obj=record(raw);
  exactKeys(obj,[
    "botToken","clearBotToken","groupId","museBotId","workspaces","defaultWorkspace",
    "wsPort","wsPath","wsMode","wsRemoteUrl","autoStartMode",
  ]);
  if(typeof obj.clearBotToken!=="boolean") throw new Error("clearBotToken must be boolean");

  const token=normalizeToken(obj.botToken);
  if(obj.clearBotToken&&token) throw new Error("Choose replacement token or clear token, not both");
  const groupId=normalizeId(obj.groupId,"Group ID",true);
  const museBotId=normalizeId(obj.museBotId,"Muse Bot ID",false);
  const workspaces=normalizeWorkspaces(obj.workspaces);
  const defaultWorkspace=path.resolve(String(obj.defaultWorkspace||workspaces[0]));
  if(!workspaces.some(w=>(process.platform==="win32"?w.toLowerCase():w)===
      (process.platform==="win32"?defaultWorkspace.toLowerCase():defaultWorkspace)))
    throw new Error("Default workspace must be one of the watched workspaces");

  const wsPort=Number(obj.wsPort);
  if(!Number.isSafeInteger(wsPort)||wsPort<1024||wsPort>65535||
     [7888,7891,7892,9227].includes(wsPort))
    throw new Error("Muse WebSocket port is invalid or reserved");
  const wsPath=normalizeWsPath(obj.wsPath);
  const wsMode=obj.wsMode==="client"?"client":obj.wsMode==="server"?"server":null;
  if(!wsMode) throw new Error("Muse WebSocket mode must be server or client");
  const wsRemoteUrl=normalizeWsRemoteUrl(obj.wsRemoteUrl,wsMode);
  const autoStartMode=["off","telegram","websocket"].includes(String(obj.autoStartMode))
    ? obj.autoStartMode as "off"|"telegram"|"websocket"
    : null;
  if(!autoStartMode) throw new Error("Muse auto-start mode is invalid");

  const before=loadRemoteAgentConfig();
  if(obj.clearBotToken===true) setMuseTelegramBotTokenSecure(undefined);
  else if(token) setMuseTelegramBotTokenSecure(token);
  else if(before.botToken&&!before.botTokenSecretRef) migrateMuseTelegramBotTokenToSecureStorage();

  updateRemoteAgentConfig({
    groupId:groupId||undefined,
    museBotId:museBotId||undefined,
    workspaces,
    defaultWorkspace,
    wsPort,
    wsPath,
    wsHost:"127.0.0.1",
    wsMode,
    wsRemoteUrl:wsMode==="client"?wsRemoteUrl:undefined,
    museAutoStartMode:autoStartMode,
  });

  const after=loadRemoteAgentConfig();
  if(autoStartMode==="telegram"&&!(after.botToken&&groupId&&museBotId))
    throw new Error("Telegram auto-start requires token, Group ID and Muse Bot ID");
  if(autoStartMode==="websocket"&&!after.wsToken)
    throw new Error("WebSocket auto-start requires a configured Muse WebSocket token");

  return await buildView();
}

async function telegramApi(token:string,method:string,params:Record<string,string|number>={}){
  const query=new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)]));
  const url="https://api.telegram.org/bot"+token+"/"+method+(query.size?"?"+query.toString():"");
  const res=await fetch(url,{signal:AbortSignal.timeout(10000),redirect:"error"});
  const data=await res.json().catch(()=>({})) as any;
  return {ok:Boolean(res.ok&&data?.ok),status:res.status,result:data?.result,
    description:String(data?.description||"").slice(0,160)};
}

export async function testMuseTelegramSettings(){
  const cfg=loadRemoteAgentConfig();
  const groupConfigured=Boolean(cfg.groupId!==undefined&&cfg.groupId!=="");
  const museBotConfigured=Boolean(cfg.museBotId!==undefined&&cfg.museBotId!=="");
  const pollingOwner=cfg.botToken
    ? await inspectTelegramPollingOwner(cfg.botToken).catch(()=>({active:false} as any))
    : {active:false} as any;

  if(!cfg.botToken){
    return {success:false,botOnline:false,groupConfigured,museBotConfigured,
      pollingOwnerPid:null,pollingConflict:false,checks:["Bot token: MISSING"],
      message:"Bot token is not configured"};
  }

  const me=await new MuseClient(cfg).getMeInfo();
  const checks:string[]=[];
  if(!me.ok){
    return {success:false,botOnline:false,groupConfigured,museBotConfigured,
      pollingOwnerPid:pollingOwner.active?pollingOwner.pid:null,
      pollingConflict:Boolean(pollingOwner.active&&pollingOwner.pid!==process.pid),
      checks:["Bot API: FAILED"],message:"Telegram Bot API rejected the configured token"};
  }
  checks.push("Bot API: ONLINE");
  checks.push(me.canReadGroupMessages===false
    ?"Privacy mode: WARNING (bot cannot read all group messages)"
    :"Privacy mode: OK");

  let groupOnline=false,botMembership=false,museMembership=false,webhookConflict=false;
  if(groupConfigured){
    const chat=await telegramApi(cfg.botToken,"getChat",{chat_id:String(cfg.groupId)});
    groupOnline=chat.ok;
    checks.push(chat.ok?"Group ID: VERIFIED":"Group ID: FAILED");
    const botMember=await telegramApi(cfg.botToken,"getChatMember",{
      chat_id:String(cfg.groupId),user_id:Number(me.id||0),
    });
    botMembership=botMember.ok&&!["left","kicked"].includes(String(botMember.result?.status||""));
    checks.push(botMembership?"Bot membership: VERIFIED":"Bot membership: FAILED");
    if(museBotConfigured){
      const museMember=await telegramApi(cfg.botToken,"getChatMember",{
        chat_id:String(cfg.groupId),user_id:Number(cfg.museBotId),
      });
      museMembership=museMember.ok&&!["left","kicked"].includes(String(museMember.result?.status||""));
      checks.push(museMembership?"Muse sender membership: VERIFIED":"Muse sender membership: FAILED");
    }
  }
  const webhook=await telegramApi(cfg.botToken,"getWebhookInfo");
  webhookConflict=Boolean(webhook.ok&&String(webhook.result?.url||""));
  checks.push(webhookConflict?"Webhook: CONFLICT with long polling":"Webhook: clear");
  const pollingConflict=Boolean(pollingOwner.active&&pollingOwner.pid!==process.pid);
  checks.push(pollingConflict
    ?"Local getUpdates owner: CONFLICT PID "+pollingOwner.pid
    : pollingOwner.active?"Local getUpdates owner: current Core":"Local getUpdates owner: free");

  const success=Boolean(me.ok&&groupConfigured&&museBotConfigured&&groupOnline&&
    botMembership&&museMembership&&!webhookConflict&&!pollingConflict);
  return {
    success,botOnline:true,username:me.username,firstName:me.firstName,
    canReadGroupMessages:me.canReadGroupMessages,groupConfigured,museBotConfigured,
    groupOnline,botMembership,museMembership,webhookConflict,
    pollingOwnerPid:pollingOwner.active?pollingOwner.pid:null,pollingConflict,
    checks,
    message:success
      ?"Telegram Doctor passed without sending a message"
      :"Telegram Doctor found one or more configuration/ownership issues",
  };
}

export async function regenerateMuseWsTokenForTray(){
  const watcher=getMuseWatcher();
  if(watcher?.isActive())
    throw new Error("Muse Watch is active. Use Runtime Detection → Regenerate Muse Token for live rotation");
  const cfg=loadRemoteAgentConfig();
  if((cfg.wsMode||"server")==="client")
    throw new Error("Generate Token is only available for Muse WebSocket server mode");
  const {generateSecureWsToken}=await import("../remoteAgent/config.js");
  const {copyTextToClipboard}=await import("../remoteAgent/cloudflareTunnel.js");
  const token=generateSecureWsToken();
  updateRemoteAgentConfig({wsToken:token,transport:"websocket",wsMode:"server"});
  const port=cfg.wsPort||9225;
  const wsPath=cfg.wsPath||"/muse";
  const copied=await copyTextToClipboard(
    "Muse WebSocket local connection\n"+
    "URL: ws://127.0.0.1:"+port+wsPath+"\n"+
    "Authorization: Bearer "+token
  );
  return {
    success:true,
    copied,
    settings:await buildView(),
    message:copied
      ?"New Muse WebSocket token generated and private connection copied to clipboard"
      :"New Muse WebSocket token generated; clipboard copy was unavailable",
  };
}
