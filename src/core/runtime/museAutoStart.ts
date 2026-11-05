import {
  loadRemoteAgentConfig,
  migrateMuseTelegramBotTokenToSecureStorage,
} from "../remoteAgent/config.js";
import { getMuseWatcher } from "../remoteAgent/museWatcherRegistry.js";

let scheduled=false;

function safeError(error:unknown){
  return (error instanceof Error?error.message:String(error))
    .replace(/Bearer\s+\S+/gi,"Bearer [REDACTED]")
    .replace(/[0-9]{5,20}:[A-Za-z0-9_-]{20,180}/g,"[REDACTED_BOT_TOKEN]")
    .slice(0,180);
}

export function scheduleMuseAutoStart(){
  if(scheduled||process.env.VITEST||process.env.NODE_ENV==="test"||
     process.env.SUPERAGENT_MUSE_AUTOSTART==="0") return;
  scheduled=true;

  const attempt=async(count:number)=>{
    // One-time security migration at Core startup. Failure does not destroy the
    // legacy credential or block Core readiness; Settings will surface storage.
    try { migrateMuseTelegramBotTokenToSecureStorage(); }
    catch(error) { console.warn("[Muse Watch] Telegram credential migration skipped:",safeError(error)); }
    const cfg=loadRemoteAgentConfig();
    const mode=cfg.museAutoStartMode||"off";
    if(mode==="off") return;
    if(getMuseWatcher()?.isActive()) return;

    try{
      const {controlCoreLocalMuse}=await import("./desktopMuseLifecycle.js");
      await controlCoreLocalMuse("start",process.pid,{
        mode,
        port:cfg.wsPort||9225,
      });
      console.log("[Muse Watch] Auto-started "+mode+" transport.");
    }catch(error){
      const message=safeError(error);
      const retryable=/OWNER_CONFLICT|OWNER_RACE|already running|EADDRINUSE|address.*use|lifecycle change/i.test(message);
      if(retryable&&count<12){
        setTimeout(()=>void attempt(count+1),5000).unref?.();
        return;
      }
      console.warn("[Muse Watch] Auto-start skipped:",message);
    }
  };

  setTimeout(()=>void attempt(0),750).unref?.();
}
