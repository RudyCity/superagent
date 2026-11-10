/**
 * Frame-local read/typing/scroll utilities. These reuse the exact qualified
 * frame context and never fall back to the parent page on OOPIF failures.
 * No typed values are returned, persisted or added to browser recordings.
 */
import {withCdpFrameContext} from "./chromeCdpFrames.js";
import {executeTargetHighlightCommand} from "./chromeCdpTargetHighlight.js";
type Send=(target:any,method:string,params?:Record<string,unknown>,sessionId?:string)=>Promise<any>;
export async function executeFrameUtility(send:Send,target:any,
 command:"frame_snapshot"|"frame_type"|"frame_scroll",
 payload:{frameId?:unknown;selector?:unknown;text?:unknown;deltaX?:unknown;deltaY?:unknown},
 actorId:string):Promise<string>{
 const frameId=payload.frameId;
 if(typeof frameId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(frameId))
   throw Error("Explicit child iframe frameId required.");
 return withCdpFrameContext(send,target,frameId,async scoped=>{
   if(command==="frame_snapshot"){
     const expression=`(() => Array.from(document.querySelectorAll('button,a,input,textarea,select,[role=button],[role=textbox]'))
       .slice(0,80).map((el,index)=>({index,tag:String(el.tagName||'').toLowerCase(),
         type:String(el.getAttribute('type')||'').slice(0,24),
         label:String(el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,100),
         disabled:!!el.disabled||el.getAttribute('aria-disabled')==='true'})))()`;
     const result=(await scoped(target,"Runtime.evaluate",{expression,returnByValue:true}))?.result?.value;
     if(!Array.isArray(result))throw Error("Iframe snapshot unavailable.");
     return JSON.stringify({status:"frame_snapshot",frameId,elements:result.slice(0,80)});
   }
   if(command==="frame_scroll"){
     const dx=Number(payload.deltaX??0),dy=Number(payload.deltaY??0);
     if(!Number.isFinite(dx)||!Number.isFinite(dy)||Math.abs(dx)>10000||Math.abs(dy)>10000||
        (!dx&&!dy))throw Error("Frame scroll requires bounded nonzero delta.");
     const expression=`(() => {const root=document.scrollingElement||document.documentElement;
       const before={x:root.scrollLeft,y:root.scrollTop};
       window.scrollBy(${dx},${dy});
       return {before,after:{x:root.scrollLeft,y:root.scrollTop}};})()`;
     const result=(await scoped(target,"Runtime.evaluate",{expression,returnByValue:true}))?.result?.value;
     if(!result?.after||!Number.isFinite(result.after.x)||!Number.isFinite(result.after.y))
       throw Error("Iframe scroll unavailable.");
     return JSON.stringify({status:"frame_scrolled",frameId,...result,
       note:"Frame-local DOM scroll, not a native mouseWheel event."});
   }
   const selector=payload.selector,text=payload.text;
   if(typeof selector!=="string"||selector.length<1||selector.length>500||
       typeof text!=="string"||text.length<1||text.length>10000||text.includes("\0"))
     throw Error("Iframe type requires bounded CSS selector and nonempty text.");
   // Same visibility/occlusion check as direct top-level target handling.
   const checked=await executeTargetHighlightCommand(scoped,target,"highlight_target",
     {selector,ttlMs:1000},actorId);
   if(!checked.startsWith("{"))throw Error("Iframe input unavailable: "+checked);
   const expression=`(() => {
     try {
       const el=document.querySelector(${JSON.stringify(selector)});
       if(!el||!(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement)||
          el.disabled||el.readOnly||el.type==='file')return {ok:false,code:'FIELD_UNAVAILABLE'};
       const before=el.value;
       const setter=Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement
         ? HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')?.set;
       if(!setter)return {ok:false,code:'NATIVE_SETTER_UNAVAILABLE'};
       setter.call(el,${JSON.stringify(text)});
       if(el._valueTracker?.setValue)el._valueTracker.setValue(before);
       el.dispatchEvent(new Event('input',{bubbles:true}));
       el.dispatchEvent(new Event('change',{bubbles:true}));
       return {ok:true,length:el.value.length};
     } catch{return {ok:false,code:'FRAME_TYPE_UNVERIFIED'};}
   })()`;
   const result=(await scoped(target,"Runtime.evaluate",{expression,returnByValue:true}))?.result?.value;
   if(result?.ok!==true)throw Error("Frame typing denied: "+String(result?.code||"unknown"));
   return JSON.stringify({status:"frame_field_updated",frameId,length:result.length,
     note:"Typed text is not included in the result or activity stream."});
 });
}
