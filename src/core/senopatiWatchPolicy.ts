/** Restart policy for the local Senopati inference-only service.
 * Does not restart CLI, tunnels, T-Line, MCP, Telegram, or agent sessions.
 */
export const SENOPATI_WATCH_CHECK_MS=2000;
export const SENOPATI_WATCH_FAILURE_THRESHOLD=2;
export const SENOPATI_WATCH_WINDOW_MS=10*60_000;
export const SENOPATI_WATCH_MAX_RESTARTS=4;
export const SENOPATI_WATCH_COOLDOWN_MS=10*60_000;
// Spread successive model bootstrap attempts to avoid a crash-loop CPU/RAM
// storm. The cooldown above remains the hard cap at four attempts per window.
export const SENOPATI_WATCH_BACKOFF_BASE_MS=2_000;
export const SENOPATI_WATCH_BACKOFF_MAX_MS=30_000;
export type SenopatiWatchState={
  failedChecks:number;
  restartTimestamps:number[];
  circuitOpenUntilMs:number;
};
export function initialWatchState():SenopatiWatchState {
  return {failedChecks:0,restartTimestamps:[],circuitOpenUntilMs:0};
}
export function decideSenopatiRestart(
  state:SenopatiWatchState,
  nowMs:number,
  enabled:boolean,
  healthy:boolean,
):{state:SenopatiWatchState;restart:boolean;breakerOpen:boolean}{
  const timestamps=state.restartTimestamps.filter(x=>nowMs-x<SENOPATI_WATCH_WINDOW_MS && x<=nowMs);
  if(!enabled || healthy){
    return {state:{failedChecks:0,restartTimestamps:timestamps,
      circuitOpenUntilMs:state.circuitOpenUntilMs},
      restart:false,breakerOpen:false};
  }
  const failures=state.failedChecks+1;
  if(nowMs<state.circuitOpenUntilMs){
    return {state:{failedChecks:failures,restartTimestamps:timestamps,
      circuitOpenUntilMs:state.circuitOpenUntilMs},
      restart:false,breakerOpen:true};
  }
  if(failures<SENOPATI_WATCH_FAILURE_THRESHOLD){
    return {state:{failedChecks:failures,restartTimestamps:timestamps,
      circuitOpenUntilMs:0},restart:false,breakerOpen:false};
  }
  if(timestamps.length>=SENOPATI_WATCH_MAX_RESTARTS){
    return {state:{failedChecks:0,restartTimestamps:timestamps,
      circuitOpenUntilMs:nowMs+SENOPATI_WATCH_COOLDOWN_MS},
      restart:false,breakerOpen:true};
  }
  const last=timestamps.at(-1);
  if(last!==undefined){
    const delay=Math.min(SENOPATI_WATCH_BACKOFF_MAX_MS,
      SENOPATI_WATCH_BACKOFF_BASE_MS*2**(timestamps.length-1));
    // Keep consecutive-check threshold met while waiting; never create
    // additional attempts because of rapid polling or clock regression.
    if(nowMs<last+delay){
      return {state:{failedChecks:Math.min(failures,SENOPATI_WATCH_FAILURE_THRESHOLD),
        restartTimestamps:timestamps,circuitOpenUntilMs:0},
        restart:false,breakerOpen:false};
    }
  }
  return {state:{failedChecks:0,restartTimestamps:[...timestamps,nowMs],
    circuitOpenUntilMs:0},restart:true,breakerOpen:false};
}
