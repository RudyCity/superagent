/**
 * Certified read-only Delegate tab inventory for permanent file-policy v2.
 * This never attaches to a tab, reads DOM, evaluates scripts or touches local
 * files. All output is reconstructed from whitelisted HTTP(S) metadata.
 */
import type { BrowserTargetRef } from "../browserTransport/types.js";
import { delegateTargetId } from "../browserTransport/targetIdentity.js";
import { visibleDelegateSessions } from "../browserTransport/delegatePrincipalPolicy.js";
import { listDelegateSessions } from "../browserTransport/sessionCoordinator.js";
import { delegateCdpTransport } from "../delegate/cdpTransport.js";

type SafeTarget = { id:string; title:string; url:string; transport:"delegate" };
export function sanitizeDelegateWebTargets(targets:readonly BrowserTargetRef[]):SafeTarget[]{
 const result:SafeTarget[]=[];
 for(const target of targets.slice(0,100)){
   if(target.kind!=="delegate" || !target.tabId || typeof target.url!=="string")continue;
   let url:URL;
   try{url=new URL(target.url);}catch{continue;}
   if(url.protocol!=="http:"&&url.protocol!=="https:")continue;
   url.username="";url.password="";url.search="";url.hash="";
   let id:string;
   try{id=delegateTargetId(target.connectionId,target.tabId);}catch{continue;}
   const title=typeof target.title==="string"?
     target.title.replace(/[\r\n\t\u0000-\u001f]/g," ").slice(0,160):"";
   result.push({id,title,url:url.toString(),transport:"delegate"});
 }
 return result;
}
export async function safeDelegateChromeObservation(args:Record<string,unknown>):Promise<string>{
 if(args.transport!=="delegate" ||
   (args.command!=="list_targets"&&args.command!=="transport_status"))
   throw Error("Uncertified Delegate CDP action");
 const clientId=typeof args.delegateClientId==="string"?args.delegateClientId:undefined;
 let targets:BrowserTargetRef[];
 try{
   targets=await delegateCdpTransport.listTargets(clientId);
 }catch{
   if(args.command==="transport_status")return JSON.stringify({
     transport:"delegate",reachable:false,
     diagnostic:"Delegate profile unavailable or ambiguous. Use an online delegateClientId from superagent_delegate_read_chat({connections:true}).",
     filePolicyRestricted:true,localFileTabsExcluded:true,
   });
   throw Error("DELEGATE_INVENTORY_UNAVAILABLE: Select an online Delegate profile using delegateClientId.");
 }
 // A tab claimed by another principal must never appear in this MCP inventory.
 const sessions=listDelegateSessions();
 const owned=visibleDelegateSessions(sessions);
 const permitted=targets.filter(t=>{
   const claimed=sessions.find(s=>s.clientId===t.connectionId&&s.tabId===t.tabId);
   return !claimed||owned.includes(claimed);
 });
 const rows=sanitizeDelegateWebTargets(permitted);
 if(args.command==="transport_status")return JSON.stringify({
   transport:"delegate",reachable:true,certifiedHttpTargets:rows.length,
   filePolicyRestricted:true,localFileTabsExcluded:true,
 });
 return rows.length?rows.map(t=>
   `- id: ${t.id}\n  title: ${t.title}\n  url: ${t.url}\n  transport: delegate`).join("\n"):
   "Delegate connected; no certified HTTP(S) page targets visible to this MCP connection.";
}
