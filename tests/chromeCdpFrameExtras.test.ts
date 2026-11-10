import {describe,expect,test} from "vitest";
import {executeFrameUtility} from "../src/core/tools/chromeCdpFrameExtras.js";

const tree={frameTree:{frame:{id:"main",url:"https://parent.test/"},
  childFrames:[{frame:{id:"child",url:"https://child.test/"}}]}};
describe("qualified iframe snapshot/type/scroll utilities",()=>{
 test("runs bounded snapshot solely inside the qualified frame context",async()=>{
   const seen:Array<{method:string;params:any}>=[];
   const send=async(_t:any,method:string,params:any)=>{
     seen.push({method,params});
     if(method==="Page.getFrameTree")return tree;
     if(method==="Page.createIsolatedWorld")return {executionContextId:5};
     if(method==="Runtime.evaluate")return {result:{value:[{index:0,tag:"input",label:"Name"}]}};
     return {};
   };
   const result=JSON.parse(await executeFrameUtility(send,{},"frame_snapshot",
     {frameId:"child"},"agent"));
   expect(result.elements).toHaveLength(1);
   expect(seen.filter(row=>row.method==="Runtime.evaluate")
     .every(row=>row.params.contextId===5)).toBe(true);
 });
 test("typing rejects invalid length and never dispatches into parent frame",async()=>{
   const calls:string[]=[];
   const send=async(_t:any,method:string,params:any)=>{
     calls.push(method);
     if(method==="Page.getFrameTree")return tree;
     if(method==="Page.createIsolatedWorld")return {executionContextId:9};
     return {result:{value:{ok:true,rect:{x:1,y:1,width:100,height:40}}}};
   };
   await expect(executeFrameUtility(send,{},"frame_type",{frameId:"wrong",
     selector:"#a",text:"private"},"agent")).rejects.toThrow(/refresh inspect_frames/);
   await expect(executeFrameUtility(send,{},"frame_type",{frameId:"child",
     selector:"#a",text:"x".repeat(10001)},"agent")).rejects.toThrow(/bounded/);
   expect(calls).not.toContain("Input.insertText");
 });
 test("scroll rejects unbounded values without emitting Runtime.evaluate",async()=>{
   const calls:string[]=[];
   const send=async(_t:any,method:string,_params:any)=>{
     calls.push(method);
     if(method==="Page.getFrameTree")return tree;
     if(method==="Page.createIsolatedWorld")return {executionContextId:9};
     return {};
   };
   await expect(executeFrameUtility(send,{},"frame_scroll",{frameId:"child",
     deltaY:Infinity},"agent")).rejects.toThrow(/bounded/);
   expect(calls).not.toContain("Runtime.evaluate");
 });
});
