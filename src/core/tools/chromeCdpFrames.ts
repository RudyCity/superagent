/**
 * Explicit CDP frame targeting. Never silently fall back to top-level DOM
 * after a cross-origin/OOPIF frame context resolution failure.
 * The caller MUST hold the existing target read/write coordinator lease.
 */
import { executeTargetHighlightCommand } from "./chromeCdpTargetHighlight.js";

export type FrameDescriptor = {frameId:string;parentId?:string;depth:number;origin:string;isMain:boolean};
type CdpSend = (target:any,method:string,params?:Record<string,unknown>,sessionId?:string)=>Promise<any>;
const validFrameId=(x:unknown):x is string=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
function originOnly(raw:unknown):string{
 if(typeof raw!=="string")return "unknown";
 try {const parsed=new URL(raw);return ["https:","http:"].includes(parsed.protocol) ?
   parsed.origin : parsed.protocol==="about:"?"about:":parsed.protocol+"//[redacted]";}
 catch{return "unknown";}
}
export async function inspectCdpFrameTree(send:CdpSend,target:any):Promise<FrameDescriptor[]> {
 const result=await send(target,"Page.getFrameTree",{});
 const root=result?.frameTree;
 if(!root||!root.frame||!validFrameId(root.frame.id))throw Error("CDP frame tree unavailable.");
 const out:FrameDescriptor[]=[];
 const visit=(node:any,parentId:string|undefined,depth:number)=>{
   if(out.length>=64)throw Error("CDP frame tree exceeds safety capacity.");
   const id=node?.frame?.id;
   if(!validFrameId(id))throw Error("CDP frame identity unavailable.");
   if(out.some(item=>item.frameId===id))throw Error("Duplicate CDP frame identity.");
   out.push({frameId:id,...(parentId?{parentId}:{}),depth,
     origin:originOnly(node.frame.url),isMain:!parentId});
   if(depth>=8&&Array.isArray(node.childFrames)&&node.childFrames.length)
     throw Error("CDP frame nesting exceeds safety capacity.");
   for(const child of Array.isArray(node.childFrames)?node.childFrames:[])
     visit(child,id,depth+1);
 };
 visit(root,undefined,0);
 // OOPIF descendants are omitted by Page.getFrameTree on some Chromium
 // versions. Target.getTargets supplies the parentId/parentFrameId binding.
 // Never traverse unrelated page/iframe targets from another tab.
 try {
   const infos=(await send(target,"Target.getTargets",{}))?.targetInfos;
   const candidates=Array.isArray(infos)?infos.filter((x:any)=>
     x?.type==="iframe"&&validFrameId(x.targetId)&&validFrameId(x.parentId)): [];
   const pending=[...candidates];
   for(let pass=0;pass<8&&pending.length;pass++){
     let found=false;
     for(let i=pending.length-1;i>=0;i--){
       const entry=pending[i];
       const parent=out.find(f=>f.frameId===entry.parentId);
       if(!parent)continue;
       if(out.some(f=>f.frameId===entry.targetId)){pending.splice(i,1);continue;}
       if(out.length>=64)throw Error("CDP frame tree exceeds safety capacity.");
       if(entry.parentFrameId && entry.parentFrameId!==entry.parentId &&
          !out.some(f=>f.frameId===entry.parentFrameId)){
         continue;
       }
       out.push({frameId:entry.targetId,
         parentId:validFrameId(entry.parentFrameId)?entry.parentFrameId:entry.parentId,
         depth:parent.depth+1,origin:originOnly(entry.url),isMain:false});
       pending.splice(i,1);found=true;
     }
     if(!found)break;
   }
 }catch(error){
   if(error instanceof Error && /safety capacity/.test(error.message))throw error;
   // Without target discovery, same-renderer frame tree remains usable.
 }
 return out;
}
export async function withCdpFrameContext<T>(
 send:CdpSend,target:any,frameId:string,
 task:(sendScoped:(target:any,method:string,params?:Record<string,unknown>)=>Promise<any>,
   frame:FrameDescriptor)=>Promise<T>,
):Promise<T>{
 if(!validFrameId(frameId))throw Error("Explicit valid frameId required.");
 const frames=await inspectCdpFrameTree(send,target);
 const match=frames.find(row=>row.frameId===frameId);
 if(!match||match.isMain)throw Error("Explicit child iframe identity required; refresh inspect_frames.");
 let executionContextId:number|undefined,sessionId:string|undefined;
 try {
   const isolated=await send(target,"Page.createIsolatedWorld",{
     frameId,worldName:"__superagent_qualified_frame__",grantUniveralAccess:false,
   });
   if(Number.isSafeInteger(isolated?.executionContextId)&&isolated.executionContextId>0)
     executionContextId=isolated.executionContextId;
 } catch { /* OOPIF may not have an execution context on the parent session. */ }
 if(!executionContextId){
   // An OOPIF is a separate target. Attach to that *exact* descendant only.
   // Never call Runtime.evaluate on the parent page as a fallback.
   const attached=await send(target,"Target.attachToTarget",{targetId:frameId,flatten:true});
   if(!attached?.sessionId||typeof attached.sessionId!=="string")
     throw Error("Cross-origin iframe session unavailable; refusing parent fallback.");
   sessionId=attached.sessionId;
   try{
     await send(target,"Page.enable",{},sessionId);
     const child=await send(target,"Page.getFrameTree",{},sessionId);
     if(child?.frameTree?.frame?.id!==frameId)
       throw Error("Attached CDP child target identity mismatch.");
   }catch(error){
     try{await send(target,"Target.detachFromTarget",{sessionId});}catch{}
     throw error;
   }
 }
 const scoped=async (_target:any,method:string,params:Record<string,unknown>={})=>{
   if(method==="Runtime.evaluate"&&executionContextId)
     return send(target,method,{...params,contextId:executionContextId});
   if(sessionId)return send(target,method,params,sessionId);
   throw Error("Only scoped Runtime.evaluate is supported for same-process frames.");
 };
 try{
   // Resolve frame identity once more after potentially asynchronous attach.
   const latest=await inspectCdpFrameTree(send,target);
   if(!latest.some(f=>f.frameId===frameId&&f.parentId===match.parentId))
     throw Error("CDP iframe detached or navigated during qualification.");
   return await task(scoped,match);
 } finally {
   if(sessionId){
     try{await send(target,"Target.detachFromTarget",{sessionId});}catch{
       // An unconfirmed detach is not a reason to re-dispatch a mutation.
     }
   }
 }
}
export function buildFrameClickJs(selector:string):string {
 return `(() => {
   const selector=${JSON.stringify(selector)};
   const locate=(root,depth)=>{
     let node=root.querySelector(selector);
     if(node||depth>=3)return node;
     let visited=0;
     for(const element of root.querySelectorAll('*')){
       if(++visited>3000)break;
       if(element.shadowRoot){node=locate(element.shadowRoot,depth+1);if(node)return node;}
     }
     return null;
   };
   try {
     const element=locate(document,0);
     if(!element)return {ok:false,code:'TARGET_NOT_FOUND'};
     if(element.matches(':disabled')||element.getAttribute('aria-disabled')==='true')
       return {ok:false,code:'TARGET_DISABLED'};
     element.click();
     return {ok:true,code:'FRAME_CLICK_DISPATCHED',tag:String(element.tagName||'').toLowerCase()};
   } catch{return {ok:false,code:'FRAME_CLICK_UNVERIFIED'};}
 })()`;
}
export async function executeQualifiedFrameAction(
 send:CdpSend,target:any,command:"frame_highlight"|"frame_click"|"frame_read",
 payload:{frameId?:unknown;selector?:unknown},
 actorId:string,
):Promise<string>{
 const frameId=payload.frameId,selector=payload.selector;
 if(!validFrameId(frameId))throw Error("Explicit iframe frameId required.");
 if(command!=="frame_read"&&(typeof selector!=="string"||!selector.trim()||selector.length>500))
   throw Error("Explicit bounded CSS selector required for iframe action.");
 return withCdpFrameContext(send,target,frameId,async scoped=>{
   if(command==="frame_read"){
     const r=await scoped(target,"Runtime.evaluate",{
       expression:"({title:String(document.title||'').slice(0,120),text:String(document.body?.innerText||'').slice(0,10000),frameId:location.origin})",
       returnByValue:true,
     });
     const v=r?.result?.value;
     if(!v||typeof v.text!=="string")throw Error("Iframe content unavailable.");
     return JSON.stringify({status:"read",frameId,
       title:String(v.title||"").slice(0,120),text:v.text.slice(0,10000)});
   }
   const preflight=async()=>{
     const status=await executeTargetHighlightCommand(scoped,target,"highlight_target",
       {selector,ttlMs:1600},actorId);
     if(!status.startsWith("{"))throw Error(status);
     const rect=JSON.parse(status).rect;
     if(!rect||![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite))
       throw Error("Iframe target geometry unavailable.");
     return rect as {x:number;y:number;width:number;height:number};
   };
   const first=await preflight();
   if(command==="frame_highlight")
     return JSON.stringify({status:"highlighted",frameId,rect:first});
   const second=await preflight();
   if(["x","y","width","height"].some(key=>
      Math.abs((first as any)[key]-(second as any)[key])>4))
     throw Error("Iframe target moved before click; denied.");
   const value=(await scoped(target,"Runtime.evaluate",{
     expression:buildFrameClickJs(selector as string),returnByValue:true,
   }))?.result?.value;
   if(value?.ok!==true)throw Error("Iframe click rejected: "+String(value?.code||"unknown"));
   return JSON.stringify({status:"frame_dom_click_dispatched_once",frameId,
     note:"One DOM click dispatched in the exact qualified iframe context."});
 });
}
