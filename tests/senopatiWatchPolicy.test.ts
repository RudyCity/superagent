import {describe,it,expect} from "vitest";
import {
  SENOPATI_WATCH_MAX_RESTARTS,SENOPATI_WATCH_COOLDOWN_MS,
  SENOPATI_WATCH_WINDOW_MS,
  decideSenopatiRestart,initialWatchState,
} from "../src/core/senopatiWatchPolicy.js";

describe("Senopati crash recovery backoff and owner isolation",()=>{
  it("does not start when disabled or when healthy",()=>{
   const now=Date.now();
   for(const flags of [[false,false],[false,true],[true,true]] as const){
    const result=decideSenopatiRestart(initialWatchState(),now,...flags);
    expect(result.restart).toBe(false);
    expect(result.state.failedChecks).toBe(0);
   }
  });
  it("requires two failed health checks before attempting restart",()=>{
   const first=decideSenopatiRestart(initialWatchState(),1000,true,false);
   expect(first.restart).toBe(false);
   expect(first.state.failedChecks).toBe(1);
   const second=decideSenopatiRestart(first.state,3000,true,false);
   expect(second.restart).toBe(true);
   expect(second.state.failedChecks).toBe(0);
   expect(second.state.restartTimestamps).toEqual([3000]);
  });
  it("does not restart repeatedly while recovering",()=>{
   let s=initialWatchState();
   let count=0;
   for(let i=0;i<12;i++){
    const answer=decideSenopatiRestart(s,10000+i*2000,true,false);
    s=answer.state;
    if(answer.restart)count++;
   }
   expect(count).toBe(SENOPATI_WATCH_MAX_RESTARTS);
   expect(s.circuitOpenUntilMs).toBeGreaterThan(0);
  });
  it("opens cooldown circuit after four spaced restart attempts",()=>{
   let state=initialWatchState();
   const now=10_000;
   // Backoff after each launch attempt: 2s, 4s and 8s spacing.
   const attempts=[now+1,now+2101,now+6201,now+14301];
   for(const at of attempts){
    state=decideSenopatiRestart(state,at-1,true,false).state;
    const result=decideSenopatiRestart(state,at,true,false);
    expect(result.restart).toBe(true);
    state=result.state;
   }
   const last=attempts[attempts.length-1];
   const attempt1=decideSenopatiRestart(state,last+1,true,false);
   const attempt2=decideSenopatiRestart(attempt1.state,last+2,true,false);
   expect(attempt2.restart).toBe(false);
   expect(attempt2.breakerOpen).toBe(true);
   expect(attempt2.state.circuitOpenUntilMs).toBe(last+2+SENOPATI_WATCH_COOLDOWN_MS);
  });
  it("recovers from circuit after the rolling restart window elapses",()=>{
   const now=15000;
   const withOld={
    failedChecks:1,
    restartTimestamps:Array.from({length:4},(_,i)=>now+i),
    circuitOpenUntilMs:now+10000,
   };
   const blocked=decideSenopatiRestart(withOld,now+5000,true,false);
   expect(blocked.restart).toBe(false);
   const ready=decideSenopatiRestart(blocked.state,now+SENOPATI_WATCH_WINDOW_MS+12000,true,false);
   expect(ready.restart).toBe(true);
   expect(ready.state.restartTimestamps).toHaveLength(1);
  });
  it("paces repeated attempts despite rapid polling",()=>{
   let state=decideSenopatiRestart(initialWatchState(),1000,true,false).state;
   const first=decideSenopatiRestart(state,3000,true,false);
   expect(first.restart).toBe(true);
   state=first.state;
   for(const at of [3001,3100,4000,4999]){
    const result=decideSenopatiRestart(state,at,true,false);
    expect(result.restart).toBe(false);
    state=result.state;
   }
   const second=decideSenopatiRestart(state,5000,true,false);
   expect(second.restart).toBe(true);
   const thirdWait=decideSenopatiRestart(second.state,7500,true,false);
   expect(thirdWait.restart).toBe(false);
   const third=decideSenopatiRestart(thirdWait.state,9000,true,false);
   expect(third.restart).toBe(true);
  });
  it("never starts a new model when a healthy owner has recovered",()=>{
   const before=decideSenopatiRestart(initialWatchState(),1000,true,false);
   const recovered=decideSenopatiRestart(before.state,2000,true,true);
   expect(recovered.restart).toBe(false);
   expect(recovered.state.failedChecks).toBe(0);
  });
});
