import { describe, expect, it } from "vitest";
import { studioTimelineProbeFrames } from "../src/core/motion/code/studioTimelineProbes.js";

describe("bounded independent Video-to-Code timeline probes", () => {
  it.each([30, 90, 180, 360])("samples across the full %i-frame clip, including near the tail", total => {
    const tracked = Array.from({length:5}, (_,index)=>
      Math.round((total-1)*.96*index/4));
    const frames = studioTimelineProbeFrames(total,tracked);
    expect(frames.length).toBeGreaterThanOrEqual(16);
    expect(frames.length).toBeLessThanOrEqual(20);
    expect(new Set(frames).size).toBe(frames.length);
    expect(frames.every((item,index)=>item>=0 && item<total &&
      !tracked.includes(item) && (!index || frames[index-1]<item))).toBe(true);
    expect(frames[0]).toBeLessThan(total*.15);
    expect(frames.at(-1)!).toBeGreaterThanOrEqual(total-4);
    for (let index=1;index<tracked.length;index++) {
      const midpoint=Math.round((tracked[index-1]+tracked[index])/2);
      if (!tracked.includes(midpoint)) expect(frames).toContain(midpoint);
    }
  });
  it("rejects invalid or malicious sampling configuration",()=>{
    expect(()=>studioTimelineProbeFrames(900,[0,200])).toThrow(/Invalid/);
    expect(()=>studioTimelineProbeFrames(60,[0,0,50])).toThrow(/Invalid/);
    expect(()=>studioTimelineProbeFrames(60,[0,30,59],100)).toThrow(/Invalid/);
    expect(()=>studioTimelineProbeFrames(60,[-1,29])).toThrow(/Invalid/);
  });
});
