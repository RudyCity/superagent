/** Controlled REAL crash recovery drill of the isolated Senopati model process.
 * No other process may be killed. It refuses to proceed without authenticated
 * model IPC health, a live watchdog, and an OS-verified matching command line.
 *
 * bun scripts/senopati-crash-drill.ts --confirm-model-only
 *
 * Uses synthetic smoke text; does not connect external providers, MCP,
 * Windows services, tunnels, or customer data. This is intrusive only to
 * shared-model inference for the watchdog recovery interval.
 */
import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {getPackageRootDir} from "../src/core/config/paths.js";
import {getModernPolicy} from "../src/core/senopatiModernBert.js";
import {
  sharedSenopatiStatus,requestSharedSenopatiPrediction,
} from "../src/core/senopatiSharedClient.js";
import {readSenopatiWatchdogStatus} from "../src/core/senopatiWatchdogStatus.js";

if(process.argv[2]!=="--confirm-model-only"){
 throw new Error("Explicit --confirm-model-only required for a real crash drill");
}
const before=await sharedSenopatiStatus();
const watchdog=readSenopatiWatchdogStatus();
const policy=getModernPolicy();
if(!before || !watchdog?.alive || !watchdog.healthy ||
   watchdog.modelPid!==before.pid ||
   policy.inferenceMode!=="shared_only" ||
   !policy.enabled || before.precision!==policy.precision){
 throw new Error("Refuse crash drill: authenticated model/watchdog ownership mismatch");
}
function osCommandLine(pid:number):string {
 if(!Number.isSafeInteger(pid) || pid<=0)throw new Error("Invalid process PID");
 if(process.platform==="win32"){
  return execFileSync("powershell.exe",[
   "-NoProfile","-NonInteractive","-Command",
   "(Get-CimInstance Win32_Process -Filter 'ProcessId = "+pid+"').CommandLine",
  ],{encoding:"utf8",timeout:7500}).trim();
 }
 return execFileSync("ps",["-p",String(pid),"-o","args="],
  {encoding:"utf8",timeout:5000}).trim();
}
const command=osCommandLine(before.pid).toLowerCase().replace(/\\/g,"/");
if(!command.includes("senopati-shared.ts") || !/\bserve\b/.test(command) ||
   !command.includes("bun")){
 throw new Error("Refuse killing a process not identified as isolated Senopati model");
}
const started=Date.now();
if(process.platform==="win32"){
 execFileSync("taskkill.exe",["/PID",String(before.pid),"/F"],
  {encoding:"utf8",timeout:8000});
}else{
 process.kill(before.pid,"SIGKILL");
}
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
let after=await sharedSenopatiStatus();
for(let i=0;i<115 && (!after || after.pid===before.pid);i++){
 await sleep(350);
 after=await sharedSenopatiStatus();
}
if(!after || after.pid===before.pid ||
   after.precision!==before.precision){
 throw new Error("Watchdog did not restore a new compatible model process");
}
const prediction=await requestSharedSenopatiPrediction(
 "Tolong cari dokumentasi proyek",policy.precision);
if(prediction?.intent!=="retrieve"){
 throw new Error("Recovered Senopati did not pass synthetic inference smoke");
}
const afterWatch=readSenopatiWatchdogStatus();
const record={
 version:"V6.9-controlled-force-kill",
 actualAbruptModelCrash:true,
 onlyPidKilled:before.pid,
 previousModelPid:before.pid,newModelPid:after.pid,
 watchdogPidBefore:watchdog.pid,
 watchdogPidAfter:afterWatch?.pid||null,
 watchdogUninterrupted:afterWatch?.pid===watchdog.pid,
 recoveryMs:Date.now()-started,
 modelPrecision:after.precision,
 tokenizerEngine:after.tokenizerEngine,
 memoryMiB:after.rssMiB,
 smokeIntent:prediction.intent,
 otherCliTlineMcpTunnelPidsUntouchedByScript:true,
 productionSafetyApproval:false,
 };
const dir=path.join(getPackageRootDir(),"models","senopati","mmbert-v64-seed73");
const report=path.join(dir,"v69_abrupt_crash_recovery_drill_v2_profile_namespace.json");
if(fs.existsSync(report))throw new Error("Refuse crash drill report overwrite");
fs.writeFileSync(report,JSON.stringify(record,null,2)+"\n");
console.log("SENOPATI_ABRUPT_CRASH_RECOVERY_PASS",JSON.stringify(record));
