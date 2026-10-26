import {describe,it,expect} from "vitest";
import {probeTlineSessionOnce} from "../src/core/runtime/tlineReconnectProbe.js";
import {newTlineReconnectState} from "../src/core/runtime/tlineReconnectPolicy.js";

const sessionId="senopati_probe_session";
const state=newTlineReconnectState(sessionId);
const bearer="a".repeat(48);
function reply(body:unknown):Response {
  return new Response(JSON.stringify(body),{status:200,
    headers:{"Content-Type":"application/json"}});
}
async function probe(inference:unknown){
  const calls:string[]=[];
  const fetchFn:typeof fetch=async (input,init)=>{
    const url=String(input);
    calls.push((init?.method??"GET")+" "+url);
    return url.includes("_transport") ?
      reply({service:"superagent-transport-host",backendReady:true}) :
      reply({sessionId,senopatiInference:inference});
  };
  const result=await probeTlineSessionOnce({
    frontDoor:"http://127.0.0.1:54321/",bearer,state,fetchFn,
  });
  return {result,calls};
}
describe("T-Line keeps sessions independent of optional classifier",()=>{
  it.each(["healthy","degraded","disabled"] as const)(
    "reports %s model status without reconnecting or replaying a chat",
    async phase=>{
      const {result,calls}=await probe({phase,fallback:"legacy-active",
        automaticChatReplayAllowed:false});
      expect(result.inferencePhase).toBe(phase);
      expect(result.state.phase).toBe("connected");
      expect(result.sessionVerified).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls.every(x=>x.startsWith("GET "))).toBe(true);
    },
  );
  it("treats absent or malformed status as unknown, never as disconnection",async()=>{
    for(const value of [undefined,"healthy",null,{phase:"unsafe"},{
      phase:"healthy",automaticChatReplayAllowed:true}]){
      const {result}=await probe(value);
      expect(result.state.phase).toBe("connected");
      expect(result.sessionVerified).toBe(true);
      // UI hint is not permission to execute or replay anything.
      expect(result).not.toHaveProperty("replayAuthorized");
    }
  });
});
