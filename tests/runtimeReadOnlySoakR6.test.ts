import {describe,expect,it} from "vitest";
import {
 assessRuntimeReadOnlySoak,type SoakObservation,
} from "../src/core/runtime/runtimeReadOnlySoakR6.js";
const sample=(atMs:number,pids=[123,123,456],cpu=10):SoakObservation=>({
 atMs,processes:[7888,6789,9877].map((port,i)=>({
  port,pid:pids[i],cpuSeconds:cpu,
  workingSetBytes:4000000+(i*1000),handles:100+i,
 })),
});
describe("R6 read-only Windows runtime observation",()=>{
 it("observes a complete stable window without certifying it",()=>{
  const d=assessRuntimeReadOnlySoak([sample(1000),sample(3000),sample(9000,undefined,12)],8);
  expect(d.status).toBe("observed_window_complete");
  expect(d.blockers).toEqual([]);
  expect(d.portOwners["7888"]).toBe(123);
  expect(d.portOwners["6789"]).toBe(123);
  expect(d.peakWorkingSetBytes["9877"]).toBe(4002000);
  expect(d.productionCertified).toBe(false);
  expect(d.restartAllowed).toBe(false);
  expect(d.cutoverAllowed).toBe(false);
  expect(d.oauthTokenImportAllowed).toBe(false);
 });
 it("reports short or unstarted observation as incomplete",()=>{
  for(const samples of [[],[sample(0)],[sample(0),sample(1500)]]){
   const d=assessRuntimeReadOnlySoak(samples,5);
   expect(d.status).toBe("incomplete");
   expect(d.blockers).toContain("OBSERVATION_WINDOW_INCOMPLETE");
  }
 });
 it("detects owner changes and can never authorize a restart",()=>{
  const d=assessRuntimeReadOnlySoak([sample(0),sample(8000,[222,123,456])],8);
  expect(d.status).toBe("unstable");
  expect(d.blockers).toContain("PID_CHANGED_7888");
  expect(d.restartAllowed).toBe(false);
 });
 it("rejects listeners with ambiguous, zero or absent ownership",()=>{
  const a=sample(0);
  a.processes[0].pid=0;
  a.processes[1].pid=null;
  a.processes.push({...a.processes[2]});
  const d=assessRuntimeReadOnlySoak([a,sample(6000)],6);
  expect(d.status).toBe("unstable");
  expect(d.blockers).toContain("LISTENER_UNVERIFIED_7888");
  expect(d.blockers).toContain("LISTENER_UNVERIFIED_6789");
  expect(d.blockers).toContain("PORT_OBSERVATION_MISSING_9877");
 });
 it("fails closed on missing resource metrics",()=>{
  const s=sample(0);
  s.processes[0].cpuSeconds=null;
  s.processes[1].workingSetBytes=null;
  s.processes[2].handles=Number.NaN;
  const d=assessRuntimeReadOnlySoak([s,sample(6000)],6);
  expect(d.blockers).toContain("METRIC_UNVERIFIED_CPU_7888");
  expect(d.blockers).toContain("METRIC_UNVERIFIED_MEMORY_6789");
  expect(d.blockers).toContain("METRIC_UNVERIFIED_HANDLES_9877");
  expect(d.status).toBe("unstable");
 });
 it("detects observation gaps and elapsed CPU clock regression",()=>{
  const d=assessRuntimeReadOnlySoak([sample(0,undefined,12),sample(30000,undefined,7)],10,5000);
  expect(d.blockers).toContain("OBSERVATION_GAP");
  expect(d.blockers).toContain("CPU_CLOCK_REGRESSED_7888");
  expect(d.status).toBe("unstable");
 });
 it("throws on unordered timestamps or impossible configuration",()=>{
  expect(()=>assessRuntimeReadOnlySoak([sample(0),sample(0)],6)).toThrow(/unordered/);
  expect(()=>assessRuntimeReadOnlySoak([sample(100),sample(80)],6)).toThrow(/unordered/);
  for(const n of [-1,0,1.4,NaN,Infinity])
   expect(()=>assessRuntimeReadOnlySoak([],n)).toThrow(/Invalid/);
 });
 it("never confuses a complete observation with public TLS or desktop validation",()=>{
  const d=assessRuntimeReadOnlySoak([sample(0),sample(259200000,undefined,11)],259200,259200001);
  expect(d.status).toBe("observed_window_complete");
  expect(d.productionCertified).toBe(false);
  expect(d.cutoverAllowed).toBe(false);
 });
});
