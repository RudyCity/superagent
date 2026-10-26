import { describe,expect,it } from "vitest";
import { validateStudioOcclusionMapping } from "../src/core/motion/code/studioOcclusionIdentityMapping.js";
const before=[
  {x:30,y:18,width:20,height:20,color:"#ffcc66"},
  {x:70,y:18,width:20,height:20,color:"#22ddff"},
];
const after=before.map(x=>({...x}));
describe("user-confirmed occlusion identity mapping",()=>{
  it("accepts the explicitly selected stable before-to-after permutation",()=>{
    expect(validateStudioOcclusionMapping(before,after,[0,1],160,90))
      .toMatchObject({beforeToAfter:[0,1],maxColorDelta:0,maxAreaRatio:1,maxCenterDisplacement:0});
  });
  it("refuses duplicate, partial and miscolored links instead of guessing",()=>{
    expect(()=>validateStudioOcclusionMapping(before,after,[0,0],160,90)).toThrow(/distinct/);
    expect(()=>validateStudioOcclusionMapping(before,after,[1,0],160,90))
      .toThrow(/color/);
    expect(()=>validateStudioOcclusionMapping(before,after,[0],160,90)).toThrow(/distinct/);
  });
  it("refuses excessive displacement or geometric change",()=>{
    const drift=after.map(item=>({...item,x:item.x+70}));
    expect(()=>validateStudioOcclusionMapping(before,drift,[0,1],160,90))
      .toThrow(/displacement/);
    expect(()=>validateStudioOcclusionMapping(before,
      after.map(item=>({...item,width:item.width*2})),[0,1],160,90))
      .toThrow(/size/);
  });
});
