/**
 * R6 single-operator read-only runtime observation.
 * Stability is only evidence about the measured interval, never certification.
 * No process start/stop, HTTP POST, token/session access, recovery or cutover.
 */
export interface SoakProcessObservation {
  port:number;
  pid:number|null;
  cpuSeconds:number|null;
  workingSetBytes:number|null;
  handles:number|null;
}
export interface SoakObservation {
  atMs:number;
  processes:SoakProcessObservation[];
}
export interface RuntimeSoakAssessment {
  version:1;
  phase:"R6_runtime_observation";
  status:"observed_window_complete"|"unstable"|"incomplete";
  observedSeconds:number;
  sampleCount:number;
  blockers:string[];
  portOwners:Record<string,number|null>;
  peakWorkingSetBytes:Record<string,number|null>;
  peakHandles:Record<string,number|null>;
  productionCertified:false;
  restartAllowed:false;
  cutoverAllowed:false;
  oauthTokenImportAllowed:false;
}
const PORTS=[7888,6789,9877] as const;
export function assessRuntimeReadOnlySoak(
  samples:SoakObservation[], requestedSeconds:number, maxGapMs=20000,
):RuntimeSoakAssessment {
  if(!Number.isSafeInteger(requestedSeconds)||requestedSeconds<1||
     !Number.isSafeInteger(maxGapMs)||maxGapMs<1000)
    throw Error("Invalid observation duration/interval");
  const blockers:string[]=[];
  const owners:Record<string,number|null>={};
  const peaks:Record<string,number|null>={};
  const handles:Record<string,number|null>={};
  for(const port of PORTS){owners[port]=null;peaks[port]=null;handles[port]=null;}
  let unstable=false;
  for(let i=0;i<samples.length;i++){
    const current=samples[i];
    if(!Number.isSafeInteger(current.atMs)||current.atMs<0||
       (i&&current.atMs<=samples[i-1].atMs))
      throw Error("Invalid or unordered monotonic sample");
    if(i&&current.atMs-samples[i-1].atMs>maxGapMs){
      blockers.push("OBSERVATION_GAP");unstable=true;
    }
    for(const port of PORTS){
      const matches=current.processes.filter(p=>p.port===port);
      if(matches.length!==1){blockers.push("PORT_OBSERVATION_MISSING_"+port);unstable=true;continue;}
      const p=matches[0],key=String(port);
      if(!p.pid||!Number.isSafeInteger(p.pid)||p.pid<=0){
        blockers.push("LISTENER_UNVERIFIED_"+port);unstable=true;continue;
      }
      if(i===0)owners[key]=p.pid;
      else if(owners[key]!==p.pid){blockers.push("PID_CHANGED_"+port);unstable=true;}
      for(const [value,name] of [[p.cpuSeconds,"cpu"],[p.workingSetBytes,"memory"],
        [p.handles,"handles"]] as const){
        if(value===null||!Number.isFinite(value)||value<0){
          blockers.push("METRIC_UNVERIFIED_"+name.toUpperCase()+"_"+port);unstable=true;
        }
      }
      if(p.workingSetBytes!==null&&p.workingSetBytes>=0)
        peaks[key]=Math.max(peaks[key]??0,p.workingSetBytes);
      if(p.handles!==null&&p.handles>=0)
        handles[key]=Math.max(handles[key]??0,p.handles);
      if(i){
        const prev=samples[i-1].processes.find(x=>x.port===port);
        if(prev?.pid===p.pid&&prev.cpuSeconds!==null&&p.cpuSeconds!==null&&
           p.cpuSeconds+0.01<prev.cpuSeconds){
          blockers.push("CPU_CLOCK_REGRESSED_"+port);unstable=true;
        }
      }
    }
  }
  const observedSeconds=samples.length>1?
    Math.max(0,(samples.at(-1)!.atMs-samples[0].atMs)/1000):0;
  const enough=samples.length>=2&&observedSeconds>=requestedSeconds;
  if(!enough)blockers.push("OBSERVATION_WINDOW_INCOMPLETE");
  return {version:1,phase:"R6_runtime_observation",
    status:unstable?"unstable":enough?"observed_window_complete":"incomplete",
    observedSeconds,sampleCount:samples.length,
    blockers:[...new Set(blockers)],portOwners:owners,
    peakWorkingSetBytes:peaks,peakHandles:handles,
    productionCertified:false,restartAllowed:false,cutoverAllowed:false,
    oauthTokenImportAllowed:false};
}
