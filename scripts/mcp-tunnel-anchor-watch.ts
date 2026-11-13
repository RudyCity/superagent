/**
 * Independent *read-only* MCP Tunnel Anchor observer.
 *
 * Usage:
 *   bun scripts/mcp-tunnel-anchor-watch.ts once PORT
 *   bun scripts/mcp-tunnel-anchor-watch.ts watch PORT [INTERVAL_SECONDS]
 *
 * It is intentionally NOT an auto-restart supervisor. Restarting a Quick
 * Tunnel would rotate its random hostname; never claim it preserves Gemini.
 */
import {observeMcpTunnelAnchor} from "../src/core/runtime/mcpTunnelAnchorObserver.js";

const [mode,rawPort,rawInterval]=process.argv.slice(2);
const port=Number(rawPort);
if(!["once","watch"].includes(mode??"")||
   !Number.isSafeInteger(port)||port<1024||port>65535||port===7888||
   (mode==="once"&&process.argv.length!==4)||
   (mode==="watch"&&process.argv.length>5))
  throw Error("MCP_ANCHOR_OBSERVER_USAGE: once PORT | watch PORT [INTERVAL_SECONDS]");
const interval=rawInterval===undefined?15:Number(rawInterval);
if(mode==="watch"&&(!Number.isSafeInteger(interval)||interval<10||interval>300))
  throw Error("MCP_ANCHOR_OBSERVER_INTERVAL_INVALID");

let lastCode="";
let polls=0;
let busy=false;
async function poll(force=false):Promise<boolean>{
  if(busy)return false;
  busy=true;
  try{
    const status=await observeMcpTunnelAnchor(port);
    polls++;
    // Print transitions immediately and periodic evidence even when stable.
    if(force||status.code!==lastCode||polls%12===0){
      console.log(JSON.stringify({event:"mcp_anchor_observation",...status}));
    }
    lastCode=status.code;
    return status.level==="verified_local";
  }finally{busy=false;}
}
if(mode==="once"){
  // Core imports may retain unrelated timers; one-shot must exit explicitly.
  process.exit(await poll(true)?0:2);
}else{
  await poll(true);
  console.log(JSON.stringify({event:"mcp_anchor_watch_started",port,
    intervalSeconds:interval,autoRestart:false}));
  await new Promise<void>(resolve=>{
    const timer=setInterval(()=>{void poll().catch(error=>{
      console.error(JSON.stringify({event:"mcp_anchor_watch_error",port,
        error:error instanceof Error?error.message:"UNKNOWN"}));
    });},interval*1000);
    const stop=()=>{
      clearInterval(timer);
      process.off("SIGINT",stop);
      process.off("SIGTERM",stop);
      resolve();
    };
    process.once("SIGINT",stop);
    process.once("SIGTERM",stop);
  });
  // This observer is a separate CLI process, not the tunnel owner.
  process.exit(0);
}
