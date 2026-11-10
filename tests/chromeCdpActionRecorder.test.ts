import {beforeEach,describe,expect,test} from "vitest";
import {
  beginBrowserActionRecording,stopBrowserActionRecording,browserActionRecordingStatus,
  appendBrowserActionRecord,readBrowserActionRecording,previewSafeCursorReplay,
  resetActionRecordingTestState,
} from "../src/core/tools/chromeCdpActionRecorder.js";
describe("opt-in privacy-safe browser recording",()=>{
  beforeEach(resetActionRecordingTestState);
  test("nothing records before an explicit start",()=>{
    expect(appendBrowserActionRecord("target","alpha","gen","move_cursor",{x:40,y:50})).toBe(false);
  });
  test("records only command category + verified pointer coordinates, never content",()=>{
    const trace=beginBrowserActionRecording("target","alpha","gen");
    appendBrowserActionRecord("target","alpha","gen","type",undefined);
    appendBrowserActionRecord("target","alpha","gen","click",undefined);
    appendBrowserActionRecord("target","alpha","gen","move_cursor",{x:20,y:30});
    const exported=readBrowserActionRecording("target","alpha","gen",trace.recordingId);
    expect(exported.events).toHaveLength(3);
    expect(exported.events[0].position).toBeUndefined();
    expect(exported.events[2].position).toEqual({x:20,y:30});
    expect(JSON.stringify(exported)).not.toMatch(/password|cookie|token|typedText|payload|selector|url/);
    stopBrowserActionRecording("target","alpha","gen");
    expect(appendBrowserActionRecord("target","alpha","gen","click")).toBe(false);
  });
  test("never permits replay of clicks or foreign target/actor/generation",()=>{
    const trace=beginBrowserActionRecording("tab","owner","generation-1");
    appendBrowserActionRecord("tab","owner","generation-1","click");
    appendBrowserActionRecord("tab","owner","generation-1","move_cursor",{x:7,y:8});
    expect(()=>previewSafeCursorReplay("tab","owner","generation-1",trace.recordingId,1))
      .toThrow("only recorded pointer movement");
    expect(()=>previewSafeCursorReplay("tab","intruder","generation-1",trace.recordingId,2))
      .toThrow("target generation mismatch");
    expect(()=>previewSafeCursorReplay("tab","owner","generation-2",trace.recordingId,2))
      .toThrow("target generation mismatch");
    expect(previewSafeCursorReplay("tab","owner","generation-1",trace.recordingId,2).position)
      .toEqual({x:7,y:8});
  });
  test("a new recording invalidates prior id; action count is bounded",()=>{
    const first=beginBrowserActionRecording("tab","owner","gen");
    const second=beginBrowserActionRecording("tab","owner","gen");
    expect(()=>readBrowserActionRecording("tab","owner","gen",first.recordingId)).toThrow();
    for(let n=0;n<180;n++)appendBrowserActionRecord("tab","owner","gen","navigate");
    expect(browserActionRecordingStatus("tab","owner","gen",second.recordingId))
      .toMatchObject({active:false,recordedCount:128,capped:true});
  });
});
