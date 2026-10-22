import { describe, expect, it, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
vi.mock("../src/core/tools/cliBridgeTool.js", () => ({ cliBridgeTool: { execute: vi.fn(async () => ({ ok: true })) } }));
import { dispatchBrainMcpTool } from "../src/core/mcp/tools/brainMcpTools.js";

const dirs: string[] = [];
afterEach(()=>{delete process.env.SUPERAGENT_CONFIG_DIR;for(const dir of dirs.splice(0))fs.rmSync(dir,{force:true,recursive:true})});
function setup(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"brain-stream-"));
 dirs.push(root);process.env.SUPERAGENT_CONFIG_DIR=root;return root;
}
const parse=(resp:any)=>resp?.isError?{error:resp.content[0].text}:JSON.parse(resp.content[0].text);
const call=async(owner:string,action:string,extra:Record<string,unknown>={})=>
 parse(await dispatchBrainMcpTool("superagent_brain",{action,sessionId:"session_long",...extra},owner,"transport_id"));
describe("Brain resumable streaming and owner-scoped intelligent index",()=>{
 it("resumes a durable upload over connections and validates SHA256 before exposing artifact",async()=>{
   const root=setup();
   const principal="oauth:userA";
   expect((await call(principal,"create")).sessionId).toBe("session_long");
   const payload=Buffer.alloc(380000,0x5a);const sha256=crypto.createHash("sha256").update(payload).digest("hex");
   const started=await call(principal,"transfer.begin",{filename:"archive.zip",totalBytes:payload.length,sha256});
   expect(started.chunkLimit).toBe(262144);
   const first=await call(principal,"transfer.append",{transferId:started.transferId,offset:0,base64:payload.subarray(0,262144).toString("base64")});
   expect(first.offset).toBe(262144);
   expect((await call(principal,"transfer.status",{transferId:started.transferId})).offset).toBe(first.offset);
   expect((await call(principal,"transfer.append",{transferId:started.transferId,offset:0,base64:payload.subarray(0,10).toString("base64")})).error).toMatch(/offset/i);
   expect((await call("oauth:intruder","transfer.status",{transferId:started.transferId})).error).toBeTruthy();
   const finishBefore=await call(principal,"transfer.finish",{transferId:started.transferId});
   expect(finishBefore.error).toMatch(/incomplete/i);
   expect(fs.existsSync(path.join(root,"brain",crypto.createHash("sha256").update(principal).digest("hex").slice(0,24),"session_long","artifacts","archive.zip"))).toBe(false);
   await call(principal,"transfer.append",{transferId:started.transferId,offset:262144,base64:payload.subarray(262144).toString("base64")});
   expect((await call(principal,"transfer.finish",{transferId:started.transferId})).sha256).toBe(sha256);
   expect((await call(principal,"transfer.status",{transferId:started.transferId})).error).toBeTruthy();
   const found=await call(principal,"artifact.annotate",{filePath:"artifacts/archive.zip",summary:"Experimental zip result",tags:["experiment","archive"]});
   expect(found.record.sha256).toBe(sha256);
   expect((await call(principal,"artifact.search",{query:"experimental"}))[0].sessionId).toBe("session_long");
   expect((await call("oauth:intruder","artifact.search",{query:"experimental"}))).toEqual([]);
   const resume=await call(principal,"session.resume");
   expect(resume.records[0].summary).toBe("Experimental zip result");
   expect(resume.artifacts.map((x:any)=>x.path)).toContain("artifacts/archive.zip");
   const candidate=await call(principal,"memory.candidate",{filePath:"artifacts/archive.zip"});
   expect(candidate.requiresExplicitRMemorySave).toBe(true);
   expect(candidate.content).not.toContain(payload.toString("base64").slice(0,200));
 });
 it("rejects hash mismatch, invalid metadata and keeps final artifact free of partial uploads",async()=>{
   setup();const p="oauth:owner";await call(p,"create");
   const started=await call(p,"transfer.begin",{filename:"mismatch.zip",totalBytes:4,sha256:"0".repeat(64)});
   await call(p,"transfer.append",{transferId:started.transferId,offset:0,base64:Buffer.from("test").toString("base64")});
   expect((await call(p,"transfer.finish",{transferId:started.transferId})).error).toMatch(/SHA256/i);
   expect((await call(p,"artifact.read",{filePath:"artifacts/mismatch.zip"})).error).toBeTruthy();
   expect((await call(p,"transfer.abort",{transferId:started.transferId})).aborted).toBe(true);
   expect((await call(p,"transfer.status",{transferId:started.transferId})).error).toBeTruthy();
   expect((await call(p,"transfer.begin",{filename:"../escape.zip",totalBytes:1,sha256:"a".repeat(64)})).error).toBeTruthy();
   expect((await call(p,"transfer.begin",{filename:"evil.exe",totalBytes:1,sha256:"a".repeat(64)})).error).toBeTruthy();
   expect((await call(p,"artifact.annotate",{filePath:"scratch/test.txt",summary:"Not an artifact"})).error).toBeTruthy();
 });
});
