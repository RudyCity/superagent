import {describe,it,expect} from "vitest";
import {projectSenopatiReadiness} from "../src/core/senopatiReadiness.js";
import type {SenopatiWatchdogHealth} from "../src/core/senopatiWatchdogStatus.js";

const policy={enabled:true,backend:"mmbert-v64-seed73" as const,
  inferenceMode:"shared_only" as const};
const watch:SenopatiWatchdogHealth={
  pid:123,alive:true,heartbeatFresh:true,modelPid:456,healthy:true,updatedAt:1000,
};
describe("read-only inference status for CLI and T-Line",()=>{
  it("shows last-known healthy without granting execution or replay",()=>{
    expect(projectSenopatiReadiness(policy,watch)).toEqual({
      phase:"healthy",reason:"watchdog-last-known-healthy",
      fallback:"legacy-on-error",automaticChatReplayAllowed:false,
      toolAuthorizationFromModel:false,
    });
  });
  it.each([
    null,{...watch,alive:false},{...watch,heartbeatFresh:false},
    {...watch,healthy:false},{...watch,modelPid:null},
  ])("degrades safely for missing, stale, dead or incomplete ownership",owner=>{
    const result=projectSenopatiReadiness(policy,owner);
    expect(result.phase).toBe("degraded");
    expect(result.fallback).toBe("legacy-active");
    expect(result.automaticChatReplayAllowed).toBe(false);
  });
  it("does not treat local or disabled policy as shared inference",()=>{
    expect(projectSenopatiReadiness({...policy,inferenceMode:"local"},watch).phase).toBe("disabled");
    expect(projectSenopatiReadiness({...policy,enabled:false},watch).phase).toBe("disabled");
  });
});
