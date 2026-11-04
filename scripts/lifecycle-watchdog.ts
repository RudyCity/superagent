/** Opt-in, long-lived SuperAgent service watchdog. */
import {runLifecycleWatchdog} from "../src/core/runtime/lifecycleWatchdog.js";
import {readLifecycleSettings} from "../src/core/runtime/lifecycleProfiles.js";

const args=new Set(process.argv.slice(2));
if([...args].some(x=>!["--apply","--once","--dry-run"].includes(x)))
  throw new Error("LIFECYCLE_WATCHDOG_UNKNOWN_ARGUMENT");
const apply=args.has("--apply");
if(apply&&process.env.SUPERAGENT_LIFECYCLE_WATCHDOG_APPROVED!=="1")
  throw new Error("LIFECYCLE_WATCHDOG_OPT_IN_REQUIRED");
let running=false,closing=false;
async function tick(){
  if(running||closing)return;
  running=true;
  try{
    const status=await runLifecycleWatchdog({execute:apply});
    console.log(JSON.stringify({watchdog:true,mode:apply?"apply":"dry-run",
      checkedAt:status.checkedAt,services:status.services}));
  }catch(e){
    console.error("[Lifecycle watchdog]",e instanceof Error?e.message:"failure");
    if(args.has("--once"))process.exitCode=1;
  }finally{running=false;}
}
process.on("SIGINT",()=>{closing=true;});
process.on("SIGTERM",()=>{closing=true;});
await tick();
if(!args.has("--once")){
  const policies=readLifecycleSettings().profiles;
  const interval=Math.min(...policies.map(x=>x.intervalSeconds),30)*1000;
  while(!closing){
    await new Promise(resolve=>setTimeout(resolve,interval));
    await tick();
  }
}
