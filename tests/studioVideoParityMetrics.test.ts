import { describe, expect, it } from "vitest";
import { measureStudioVideoFrameParity, studioForegroundDiffPixels } from "../src/core/motion/code/studioVideoParityMetrics.js";
import { studioTrackedObjectTransform } from "../src/core/motion/code/videoMultiObjectReconstruction.js";

function image(width:number,height:number,background:[number,number,number],
  rectangles:Array<{x:number;y:number;width:number;height:number;color:[number,number,number]}>) {
  const pixels = new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const rect=rectangles.find(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height);
    const rgb=rect?.color??background;
    const index=(y*width+x)*4;
    pixels[index]=rgb[0];pixels[index+1]=rgb[1];pixels[index+2]=rgb[2];pixels[index+3]=255;
  }
  return pixels;
}
describe("Studio video visual parity metrics",()=>{
  it("reports perfect overlap, precision, recall and zero RGB loss for identical rendered pixels",()=>{
    const pic=image(32,32,[0,0,0],[{x:5,y:5,width:10,height:10,color:[255,255,255]}]);
    expect(measureStudioVideoFrameParity(pic,pic,32,32,[0,0,0],[0,0,0])).toEqual({
      foregroundIoU:1,foregroundPrecision:1,foregroundRecall:1,foregroundF1:1,
      rgbMeanAbsoluteError:0,foregroundRgbMeanAbsoluteError:0,
    });
  });
  it("distinguishes precision, recall and color quality instead of claiming exact parity",()=>{
    const source=image(32,32,[0,0,0],[{x:5,y:5,width:10,height:10,color:[255,255,255]}]);
    const output=image(32,32,[0,0,0],[{x:5,y:5,width:15,height:10,color:[255,0,0]}]);
    const score=measureStudioVideoFrameParity(source,output,32,32,[0,0,0],[0,0,0]);
    expect(score.foregroundIoU).toBeCloseTo(2/3,3);
    expect(score.foregroundPrecision).toBeCloseTo(2/3,3);
    expect(score.foregroundRecall).toBe(1);
    expect(score.foregroundF1).toBeCloseTo(.8,3);
    expect(score.rgbMeanAbsoluteError).toBeGreaterThan(0);
    expect(score.foregroundRgbMeanAbsoluteError).toBeCloseTo(2/3,3);
  });
  it("rejects dimension mismatches and empty foreground instead of returning misleading perfect scores",()=>{
    const source=image(16,16,[0,0,0],[]);
    expect(()=>measureStudioVideoFrameParity(source,source,16,16,[0,0,0],[0,0,0]))
      .toThrow(/nonempty foreground/);
    expect(()=>measureStudioVideoFrameParity(source,source,20,20,[0,0,0],[0,0,0]))
      .toThrow(/Invalid bounded/);
  });
  it("marks reference-only, rendered-only, overlap and background pixels with deterministic diagnostic colors",()=>{
    const reference=image(16,16,[0,0,0],[{x:2,y:2,width:6,height:6,color:[255,255,255]}]);
    const rendered=image(16,16,[0,0,0],[{x:4,y:4,width:6,height:6,color:[255,255,255]}]);
    const diff=studioForegroundDiffPixels(reference,rendered,16,16,[0,0,0],[0,0,0]);
    const at=(x:number,y:number)=>Array.from(diff.slice((y*16+x)*4,(y*16+x)*4+4));
    expect(at(0,0)).toEqual([20,28,42,255]); // neither
    expect(at(2,2)).toEqual([245,69,79,255]); // missed
    expect(at(5,5)).toEqual([148,153,168,255]); // overlap
    expect(at(9,9)).toEqual([41,215,225,255]); // extra
  });

  it("produces bounded scale with center-anchor compensation and rejects extreme changes",()=>{
    const shape={width:20,height:10};
    expect(studioTrackedObjectTransform(shape,{x:15,y:25,width:20,height:10}))
      .toEqual({x:13,y:23,scaleX:1,scaleY:1});
    const grown=studioTrackedObjectTransform(shape,{x:30,y:20,width:30,height:15});
    expect(grown.scaleX).toBe(1.5);
    expect(grown.scaleY).toBe(1.5);
    expect(grown.x).toBe(34);
    expect(grown.y).toBe(21.5);
    expect(()=>studioTrackedObjectTransform(shape,{x:0,y:0,width:50,height:10}))
      .toThrow(/safe bounded/);
    expect(()=>studioTrackedObjectTransform(shape,{x:NaN,y:0,width:20,height:10}))
      .toThrow(/Invalid Studio/);
  });
});
