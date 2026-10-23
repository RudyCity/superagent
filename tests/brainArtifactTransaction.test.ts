import {afterEach,describe,it,expect,vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const get=vi.hoisted(()=>vi.fn());
vi.mock("../src/core/tools/cliBridgeDelegateJobs.js",()=>({getDelegateJob:get}));
import {createBrainSession} from "../src/core/brain/brainWorkspace.js";
import {promoteBrainDelegationBatch,recoverBrainArtifactPromotion} from "../src/core/brain/brainArtifactTransaction.js";
const roots:string[]=[];
afterEach(()=>{get.mockReset();delete process.env.SUPERAGENT_CONFIG_DIR;for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"brain-batch-"));roots.push(root);
 process.env.SUPERAGENT_CONFIG_DIR=root;
 const owner="oauth:batch",sessionId="batch_session",jobId="clj_1792656000000_deadbeef";
 const session=createBrainSession(owner,sessionId);
 const cwd=path.join(session.scratchPath,"agents","agy","task_12345678901234567890");fs.mkdirSync(cwd,{recursive:true});
 const artifacts=["alpha.txt","beta.csv"].map(name=>{
   const bytes=Buffer.from("artifact:"+name);
   fs.writeFileSync(path.join(cwd,name),bytes);
   return {path:name,state:"created",bytes:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex")};
 });
 get.mockResolvedValue({jobId,cwd,status:"succeeded",completionState:"artifacts_verified",artifactEvidence:artifacts});
 return {root,session,owner,sessionId,jobId,cwd,artifacts};
}
describe("Brain batch transaction and crash recovery",()=>{
 it("returns a validated receipt rather than re-promoting an already committed job",async()=>{
    const f=fixture();
    const first=await promoteBrainDelegationBatch(f.owner,f.sessionId,f.jobId);
    const second=await promoteBrainDelegationBatch(f.owner,f.sessionId,f.jobId);
    expect(second.replayed).toBe(true);
    expect(second.files).toEqual(first.files);
    expect(fs.readdirSync(f.session.artifactsPath)).toHaveLength(2);
    fs.writeFileSync(path.join(f.session.artifactsPath,"0-deadbeef-alpha.txt"),"tampered");
    await expect(promoteBrainDelegationBatch(f.owner,f.sessionId,f.jobId)).rejects.toThrow(/receipt/i);
 });
 it("recovers a committed journal and reconstructs its durable receipt",async()=>{
    const f=fixture();
    const folder=path.join(f.session.path,".promotion");
    fs.mkdirSync(folder);
    const item=f.artifacts[0],staging="stage-"+"c".repeat(16)+".part";
    const stage=path.join(folder,staging),target=path.join(f.session.artifactsPath,"alpha.txt");
    fs.writeFileSync(stage,fs.readFileSync(path.join(f.cwd,item.path)));fs.linkSync(stage,target);
    fs.writeFileSync(path.join(folder,"transaction.json"),JSON.stringify({
      schemaVersion:1,state:"committed",jobId:f.jobId,
      items:[{name:"alpha.txt",staging,sha256:item.sha256,bytes:item.bytes}]
    }));
    expect(recoverBrainArtifactPromotion(f.owner,f.sessionId).status).toBe("committed-cleanup");
    expect(fs.existsSync(path.join(folder,"receipts",f.jobId+".json"))).toBe(true);
    await expect(promoteBrainDelegationBatch(f.owner,f.sessionId,f.jobId))
      .rejects.toThrow(/different artifact selection/);
    expect(fs.existsSync(target)).toBe(true);
 });
 it("prevents partial output when the second destination already exists",async()=>{
   const f=fixture();fs.writeFileSync(path.join(f.session.artifactsPath,"1-deadbeef-beta.csv"),"untouched");
   await expect(promoteBrainDelegationBatch(f.owner,f.sessionId,f.jobId)).rejects.toThrow(/exists/);
   expect(fs.readFileSync(path.join(f.session.artifactsPath,"1-deadbeef-beta.csv"),"utf8")).toBe("untouched");
   expect(fs.existsSync(path.join(f.session.artifactsPath,"0-deadbeef-alpha.txt"))).toBe(false);
 });
 it("rolls back first hardlinked artifact on a mid-batch failure",async()=>{
   const f=fixture();
   await expect(promoteBrainDelegationBatch(f.owner,f.sessionId,f.jobId,{failAfterLinks:1})).rejects.toThrow(/Injected/);
   expect(fs.readdirSync(f.session.artifactsPath)).toEqual([]);
   expect(recoverBrainArtifactPromotion(f.owner,f.sessionId).status).toBe("clean");
   const promoted=await promoteBrainDelegationBatch(f.owner,f.sessionId,f.jobId);
   expect(promoted.files).toHaveLength(2);
 });
 it("recovers a simulated crashed prepared journal without deleting unrelated files",async()=>{
   const f=fixture();
   const folder=path.join(f.session.path,".promotion");
   fs.mkdirSync(folder);
   const staging="stage-"+"a".repeat(16)+".part";
   const stage=path.join(folder,staging);
   const target=path.join(f.session.artifactsPath,"old.txt");
   fs.writeFileSync(stage,"recoverable",{flag:"wx"});
   fs.linkSync(stage,target);
   const unrelated=path.join(f.session.artifactsPath,"keep.txt");
   fs.writeFileSync(unrelated,"keep");
   const sha256=crypto.createHash("sha256").update("recoverable").digest("hex");
   fs.writeFileSync(path.join(folder,"transaction.json"),JSON.stringify({
    schemaVersion:1,state:"prepared",jobId:f.jobId,items:[{name:"old.txt",staging,sha256,bytes:11}]
   }));
   expect(recoverBrainArtifactPromotion(f.owner,f.sessionId).status).toBe("rolled-back");
   expect(fs.existsSync(target)).toBe(false);
   expect(fs.readFileSync(unrelated,"utf8")).toBe("keep");
 });
 it("never removes a changed final file while processing an untrusted crash journal",async()=>{
   const f=fixture(),folder=path.join(f.session.path,".promotion");
   fs.mkdirSync(folder);
   const staging="stage-"+"b".repeat(16)+".part";
   fs.writeFileSync(path.join(folder,staging),"old");
   const final=path.join(f.session.artifactsPath,"victim.txt");
   fs.writeFileSync(final,"protected");
   fs.writeFileSync(path.join(folder,"transaction.json"),JSON.stringify({
    schemaVersion:1,state:"prepared",jobId:f.jobId,items:[{name:"victim.txt",staging,sha256:"f".repeat(64),bytes:3}]
   }));
   expect(()=>recoverBrainArtifactPromotion(f.owner,f.sessionId)).toThrow(/changed/);
   expect(fs.readFileSync(final,"utf8")).toBe("protected");
 });
});
