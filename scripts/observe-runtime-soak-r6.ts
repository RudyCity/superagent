/**
 * Read-only foreground sampler. Default 6 seconds, no file output.
 * For a long observation an operator must run it in their own session,
 * retain signed evidence, and separately certify additional release gates.
 */
import os from "node:os";
import {execFileSync} from "node:child_process";
import {performance} from "node:perf_hooks";
import {readListenerOwners} from "../src/core/runtime/coreMcpOwnershipAudit.js";
import {assessRuntimeReadOnlySoak,
  type SoakObservation,type SoakProcessObservation}
  from "../src/core/runtime/runtimeReadOnlySoakR6.js";

const seconds=process.argv[2]===undefined?6:Number(process.argv[2]);
const interval=process.argv[3]===undefined?2:Number(process.argv[3]);
if(!Number.isSafeInteger(seconds)||seconds<2||seconds>259200||
   !Number.isSafeInteger(interval)||interval<1||interval>30||
   interval>seconds)
  throw Error("Usage: bun scripts/observe-runtime-soak-r6.ts [seconds:2..259200] [intervalSeconds:1..30]");
if(process.platform!=="win32")throw Error("Windows OS metrics required for this R6 observation");
const ports=[7888,6789,9877];
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function osMetrics(pids:number[]):Map<number,{cpuSeconds:number;workingSetBytes:number;handles:number}>{
  const unique=[...new Set(pids.filter(x=>Number.isSafeInteger(x)&&x>0))];
  const result=new Map<number,{cpuSeconds:number;workingSetBytes:number;handles:number}>();
  if(!unique.length)return result;
  // All shell arguments are numeric kernel PID values; no raw profile paths,
  // app secrets or network addresses can enter the PowerShell command.
  const script="Get-Process -Id "+unique.join(",")+" -ErrorAction SilentlyContinue | "+
    "Select-Object Id,CPU,WorkingSet64,HandleCount | ConvertTo-Json -Compress";
  const raw=execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],
    {encoding:"utf8",timeout:9000,maxBuffer:32768,windowsHide:true}).trim();
  if(!raw)return result;
  const values=JSON.parse(raw);
  for(const item of Array.isArray(values)?values:[values]){
    const id=Number(item.Id),
      cpuSeconds=item.CPU==null?NaN:Number(item.CPU),
      workingSetBytes=item.WorkingSet64==null?NaN:Number(item.WorkingSet64),
      handles=item.HandleCount==null?NaN:Number(item.HandleCount);
    if(Number.isSafeInteger(id)&&Number.isFinite(cpuSeconds)&&
       Number.isFinite(workingSetBytes)&&Number.isFinite(handles))
      result.set(id,{cpuSeconds,workingSetBytes,handles});
  }
  return result;
}
function capture():SoakObservation {
  const pidMap=readListenerOwners();
  const pids=ports.map(port=>pidMap?.get(port)??null);
  let metrics=new Map<number,{cpuSeconds:number;workingSetBytes:number;handles:number}>();
  try{metrics=osMetrics(pids.filter((pid):pid is number=>pid!==null));}
  catch{ /* OS metrics unavailable => fail closed in assessor. */ }
  const processes:SoakProcessObservation[]=ports.map((port,i)=>{
    const pid=pids[i],v=pid?metrics.get(pid):undefined;
    return {port,pid,cpuSeconds:v?.cpuSeconds??null,
      workingSetBytes:v?.workingSetBytes??null,handles:v?.handles??null};
  });
  return {atMs:Math.round(performance.now()),processes};
}
const samples:SoakObservation[]=[];
samples.push(capture());
// Measure the window between actual observations, not before OS sampling.
const start=samples[0].atMs;
const maxGapMs=(interval*1000)+15000;
while(performance.now()-start<seconds*1000){
  await sleep(Math.min(interval*1000,Math.max(0,start+seconds*1000-performance.now())));
  samples.push(capture());
}
const report=assessRuntimeReadOnlySoak(samples,seconds,maxGapMs);
console.log(JSON.stringify({...report,
  machineCpuCount:os.cpus().length,
  requestedSeconds:seconds,
  intervalSeconds:interval,
  observationOnly:true,productionCertified:false},null,2));
