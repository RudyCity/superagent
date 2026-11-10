import {describe,expect,test} from "vitest";
import {
  inspectCdpFrameTree,withCdpFrameContext,executeQualifiedFrameAction,
} from "../src/core/tools/chromeCdpFrames.js";
const tree={frameTree:{frame:{id:"main",url:"https://a.test/private?secret=VALUE"},
  childFrames:[{frame:{id:"same",url:"https://a.test/frame?token=SECRET"}},
    {frame:{id:"cross",url:"https://b.test/other?password=SECRET"}}]}};
describe("explicit qualified managed CDP iframe identity",()=>{
 test("tree strips query secrets, bounds frame list and never invents frame IDs",async()=>{
   const frames=await inspectCdpFrameTree(async()=>tree,{} as any);
   expect(frames.map(f=>f.frameId)).toEqual(["main","same","cross"]);
   expect(JSON.stringify(frames)).not.toMatch(/SECRET|VALUE|token|password/);
   expect(frames[1].parentId).toBe("main");
   await expect(withCdpFrameContext(async()=>tree,{} as any,"fake",async()=>true))
     .rejects.toThrow(/refresh inspect_frames/);
 });
 test("same-process iframe uses exact isolated executionContextId",async()=>{
   const calls:any[]=[];
   const send=async(_target:any,method:string,params:any)=>{
     calls.push({method,params});
     if(method==="Page.getFrameTree")return tree;
     if(method==="Page.createIsolatedWorld")return {executionContextId:27};
     if(method==="Runtime.evaluate")return {result:{value:{title:"Frame",text:"safe body"}}};
     return {};
   };
   const output=JSON.parse(await executeQualifiedFrameAction(send,{},"frame_read",
     {frameId:"same"},"agent"));
   expect(output.text).toBe("safe body");
   expect(calls.find(c=>c.method==="Runtime.evaluate").params.contextId).toBe(27);
   expect(calls.some(c=>c.method==="Target.attachToTarget")).toBe(false);
 });
 test("cross-process attach is explicit, verifies child identity, and detaches",async()=>{
   const calls:any[]=[];
   const send=async(_target:any,method:string,params:any,sessionId?:string)=>{
     calls.push({method,params,sessionId});
     if(method==="Page.getFrameTree")return sessionId
       ? {frameTree:{frame:{id:"cross",url:"https://b.test"}}}:tree;
     if(method==="Page.createIsolatedWorld")throw Error("No frame in this renderer");
     if(method==="Target.attachToTarget")return {sessionId:"isolated-child"};
     if(method==="Runtime.evaluate")return {result:{value:{
       ok:true,code:"TARGET_HIGHLIGHTED",tag:"button",rect:{x:10,y:20,width:80,height:30},
     }}};
     return {};
   };
   const outcome=JSON.parse(await executeQualifiedFrameAction(send,{},"frame_highlight",
     {frameId:"cross",selector:"#pay"},"agent"));
   expect(outcome.status).toBe("highlighted");
   expect(calls.filter(c=>c.method==="Runtime.evaluate").every(c=>c.sessionId==="isolated-child"))
     .toBe(true);
   expect(calls.at(-1)).toMatchObject({method:"Target.detachFromTarget",
     params:{sessionId:"isolated-child"}});
 });
 test("OOPIF identity mismatch fails closed, no page evaluation",async()=>{
   let evals=0,detaches=0;
   const send=async(_target:any,method:string,_p:any,sid?:string)=>{
     if(method==="Page.getFrameTree")return sid ? {frameTree:{frame:{id:"wrong"}}}:tree;
     if(method==="Page.createIsolatedWorld")throw Error("out-of-process");
     if(method==="Target.attachToTarget")return {sessionId:"some"};
     if(method==="Target.detachFromTarget"){detaches++;return {};}
     if(method==="Runtime.evaluate")evals++;
     return {};
   };
   await expect(executeQualifiedFrameAction(send,{},"frame_click",
     {frameId:"cross",selector:"#pay"},"owner")).rejects.toThrow(/identity mismatch/);
   expect(evals).toBe(0);expect(detaches).toBe(1);
 });
});
