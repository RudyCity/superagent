import {beforeEach,afterEach,describe,expect,test} from "vitest";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {claimCdpTarget,listCdpSessions,releaseCdpTarget} from "../src/core/tools/chromeCdpSessionManager.js";
import {publishCdpCursorPresence,readCdpCursorPresence,removeCdpCursorPresence} from "../src/core/tools/chromeCdpCursorPresence.js";
describe("Cross-process CDP cursor presence",()=>{
 let temp="";
 const original=process.env.SUPERAGENT_CDP_SESSION_DIR;
 beforeEach(async()=>{
   temp=await mkdtemp(join(tmpdir(),"cdp-cursor-presence-"));
   process.env.SUPERAGENT_CDP_SESSION_DIR=temp;
 });
 afterEach(async()=>{
   if(original===undefined)delete process.env.SUPERAGENT_CDP_SESSION_DIR;
   else process.env.SUPERAGENT_CDP_SESSION_DIR=original;
   await rm(temp,{force:true,recursive:true});
 });
 test("one actor's latest cursor is available only in matching generation",async()=>{
   const claim=await claimCdpTarget(9222,"CURSOR_A","agent-alpha");
   const record={port:9222,targetId:"CURSOR_A",actorId:"agent-alpha",
     generation:claim.generation,kind:"move" as const,at:Date.now(),x:231,y:91};
   await publishCdpCursorPresence(record);
   expect(await readCdpCursorPresence(await listCdpSessions())).toEqual([record]);
   await publishCdpCursorPresence({...record,kind:"click",at:Date.now(),x:220,y:102});
   const updated=await readCdpCursorPresence(await listCdpSessions());
   expect(updated).toHaveLength(1);
   expect(updated[0]).toMatchObject({kind:"click",x:220,y:102});
   expect(await readCdpCursorPresence([{...claim,generation:"other-gen"}])).toEqual([]);
   await removeCdpCursorPresence(9222,"CURSOR_A","agent-alpha");
   expect(await readCdpCursorPresence(await listCdpSessions())).toEqual([]);
   await releaseCdpTarget(9222,"CURSOR_A","agent-alpha",claim.sessionToken);
 });
 test("rejects out-of-range coordinates and actor injection before writes",async()=>{
   const claim=await claimCdpTarget(9222,"CURSOR_B","agent-beta");
   await expect(publishCdpCursorPresence({port:9222,targetId:"CURSOR_B",actorId:"<script>",
      generation:claim.generation,kind:"type",at:Date.now()})).rejects.toThrow(/Invalid/);
   await expect(publishCdpCursorPresence({port:9222,targetId:"CURSOR_B",actorId:"agent-beta",
      generation:claim.generation,kind:"click",at:Date.now(),x:Infinity,y:10})).rejects.toThrow(/Invalid/);
   expect(await readCdpCursorPresence(await listCdpSessions())).toEqual([]);
   await releaseCdpTarget(9222,"CURSOR_B","agent-beta",claim.sessionToken);
 });
});
