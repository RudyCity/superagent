/**
 * One-shot bounded Core lifecycle observer. Verifies authenticated control
 * status via GET only. No process signals, spawn, scheduler edits or watches.
 */
import { requestCoreSupervisor, type CoreRuntimeStatus } from "./coreSupervisor.js";
import { evaluateCoreServiceLifecycle, type ServiceLifecycleInstruction } from "./coreServiceLifecycle.js";
export interface CoreLifecycleObservation {
  version: 1; port: number; collectedSamples: number;
  healthySamples: number; failedSamples: number;
  ownerStable: boolean; ownership: "verified_local"|"unverified";
  assessment: ServiceLifecycleInstruction;
  sampledMethods: readonly ["GET"];
  launchedProcesses: false; sentSignals: false; changedCheckpoints: false;
  externalChannelsTouched: false;
}
const sleep = (ms:number) => new Promise<void>(resolve=>setTimeout(resolve,ms));
export async function observeCoreLifecycle(options: {
  port:number; samples?:number; intervalMs?:number;
  status?:()=>Promise<CoreRuntimeStatus>;
  pause?:(ms:number)=>Promise<void>;
}):Promise<CoreLifecycleObservation> {
  const samples=options.samples??3, intervalMs=options.intervalMs??300;
  if (!Number.isInteger(options.port)||options.port<1024||options.port>65535||
      !Number.isInteger(samples)||samples<1||samples>10||
      !Number.isInteger(intervalMs)||intervalMs<100||intervalMs>3000) {
    throw new Error("Invalid bounded lifecycle observer options");
  }
  let healthy=0,failed=0,ownerStable=true;
  let firstOwner:number|undefined;
  let consecutive=0;
  const status=options.status??(()=>requestCoreSupervisor("status",options.port,1000));
  for(let i=0;i<samples;i++){
    try {
      const s=await status();
      if(s.publicPort!==options.port||!Number.isSafeInteger(s.supervisorPid)||s.supervisorPid<=0||
         !Number.isSafeInteger(s.active?.pid)||s.active.pid<=0) throw new Error("Unverified Core identity");
      if (firstOwner===undefined) firstOwner=s.supervisorPid;
      else if(firstOwner!==s.supervisorPid) ownerStable=false;
      healthy++;consecutive=0;
    } catch {
      failed++;consecutive++;
    }
    if(i<samples-1) await (options.pause??sleep)(intervalMs);
  }
  // Multiple successful samples verify the same authenticated control owner.
  // A dead or unreachable port has UNKNOWN ownership, never "verified_local"
  // simply because an old discovery file exists.
  ownerStable = healthy > 0 && ownerStable;
  const ownership=healthy===samples&&ownerStable ? "verified_local" : "unverified";
  const assessment=evaluateCoreServiceLifecycle({
    service:"core_supervisor",
    condition:ownership==="verified_local" ? "healthy" :
      healthy===0 ? "dead" : "degraded",
    ownership,consecutiveHealthFailures:consecutive,
    checkpointProtected:true,
  });
  return {version:1,port:options.port,collectedSamples:samples,
    healthySamples:healthy,failedSamples:failed,ownerStable,
    ownership,assessment,sampledMethods:["GET"],
    launchedProcesses:false,sentSignals:false,changedCheckpoints:false,
    externalChannelsTouched:false};
}
