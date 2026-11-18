import {describe,expect,it} from "vitest";
import {certifiedBrowserObservation} from "../src/core/tools/browserFilePolicyCertification.js";
import {sanitizeDelegateWebTargets} from "../src/core/tools/safeDelegateChromeObservation.js";
import type {BrowserTargetRef} from "../src/core/browserTransport/types.js";

const clientId="client_12345678";
const target=(tabId:number,url:string,title="Public"):BrowserTargetRef=>({
  kind:"delegate",connectionId:clientId,targetId:`tab:${tabId}`,tabId,url,title,
});

describe("file-safe Delegate CDP metadata",()=>{
 it("accepts bounded, read-only Delegate discovery but no page access or file arguments",()=>{
   for(const args of [
     {command:"list_targets",transport:"delegate"},
     {command:"transport_status",transport:"delegate"},
     {command:"list_targets",transport:"delegate",delegateClientId:clientId},
   ])expect(certifiedBrowserObservation({name:"superagent_chrome_cdp",args})).toBe(true);

   for(const args of [
     {command:"navigate",transport:"delegate",url:"https://example.org"},
     {command:"evaluate",transport:"delegate",payload:"{}"},
     {command:"list_targets",transport:"delegate",payload:"{}"},
     {command:"list_targets",transport:"delegate",filePath:"/secret"},
     {command:"list_targets",transport:"delegate",delegateClientId:"../../private"},
     {command:"transport_status",transport:"auto"},
     {command:"transport_status",transport:"delegate",debug_port:9222},
   ])expect(certifiedBrowserObservation({name:"superagent_chrome_cdp",args})).toBe(false);
 });
 it("exposes only filtered HTTP(S) targets and removes URL credentials and control characters",()=>{
   const rows:BrowserTargetRef[]=[
     target(10,"https://alice:token@example.org/album?secret=hello#hidden","Old\nPhoto"),
     target(11,"http://example.net/"),
     target(12,"file:///C:/secrets.txt","PRIVATE FILE"),
     target(13,"chrome://settings","INTERNAL"),
     target(14,"javascript:alert(1)","SCRIPT"),
     target(15,"https://example.org/","Public"),
   ];
   const output=sanitizeDelegateWebTargets(rows);
   expect(output).toHaveLength(3);
   expect(output[0]).toMatchObject({
     id:"delegate:client_12345678:10",url:"https://example.org/album",transport:"delegate",
     title:"Old Photo",
   });
   expect(JSON.stringify(output)).not.toMatch(/PRIVATE FILE|secrets|hidden|token|alice|INTERNAL|SCRIPT/);
 });
 it("fails closed for malformed target identities and bounds result size",()=>{
   const rows:BrowserTargetRef[]=[
     {...target(1,"https://example.org/"),connectionId:"bad/../path"},
     {...target(2,"https://example.org/"),tabId:-1},
     ...Array.from({length:110},(_,i)=>target(i+3,"https://example.org/")),
   ];
   const output=sanitizeDelegateWebTargets(rows);
   expect(output).toHaveLength(98);
   expect(output.every(t=>t.id.startsWith("delegate:"))).toBe(true);
 });
});
