import {afterEach,describe,it,expect} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createBrainSession} from "../src/core/brain/brainWorkspace.js";
import {createBrainTask} from "../src/core/brain/brainTasks.js";
import {issueBrainTaskAgentCredentials,authorizeBrainTaskAgent,rotateBrainTaskAgentCredential,revokeBrainTaskAgentCredential,brainTaskCapabilityStatus} from "../src/core/brain/brainAgentCredentials.js";
const roots:string[]=[];
afterEach(()=>{delete process.env.SUPERAGENT_CONFIG_DIR;for(const p of roots.splice(0))fs.rmSync(p,{recursive:true,force:true});});
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"brain-credential-"));roots.push(root);
 process.env.SUPERAGENT_CONFIG_DIR=root;
 const owner="oauth:owner",sessionId="credential_session";
 createBrainSession(owner,sessionId);
 const task=createBrainTask(owner,sessionId,"Review",["agy","claude"]);
 return {root,owner,sessionId,taskId:task.taskId};
}
describe("Brain credential lifecycle",()=>{
 it("expires, rotates and revokes without retaining plaintext secrets",()=>{
   const {root,owner,sessionId,taskId}=fixture();
   const issued=issueBrainTaskAgentCredentials(owner,sessionId,taskId,60000);
   expect(authorizeBrainTaskAgent(owner,sessionId,taskId,"agy",issued.agy)).toBe(true);
   expect(()=>authorizeBrainTaskAgent(owner,sessionId,taskId,"agy",issued.claude)).toThrow(/mismatch/);
   const next=rotateBrainTaskAgentCredential(owner,sessionId,taskId,"agy",{currentCredential:issued.agy,ttlMs:60000});
   expect(next.generation).toBe(2);
   expect(()=>authorizeBrainTaskAgent(owner,sessionId,taskId,"agy",issued.agy)).toThrow(/mismatch/);
   expect(authorizeBrainTaskAgent(owner,sessionId,taskId,"agy",next.agentCredential)).toBe(true);
   const file=path.join(root,"brain");
   const raw=fs.readFileSync(path.join(fs.readdirSync(file,{withFileTypes:true}).find(e=>e.isDirectory())?path.join(file,fs.readdirSync(file)[0]):file,sessionId,".tasks",taskId+".capabilities.json"),"utf8");
   expect(raw).not.toContain(issued.agy);expect(raw).not.toContain(next.agentCredential);
   expect(brainTaskCapabilityStatus(owner,sessionId,taskId).find(x=>x.agentId==="agy")?.generation).toBe(2);
   expect(revokeBrainTaskAgentCredential(owner,sessionId,taskId,"agy",{currentCredential:next.agentCredential}).revoked).toBe(true);
   expect(()=>authorizeBrainTaskAgent(owner,sessionId,taskId,"agy",next.agentCredential)).toThrow(/revoked/);
   expect(authorizeBrainTaskAgent(owner,sessionId,taskId,"claude",issued.claude)).toBe(true);
   expect(()=>rotateBrainTaskAgentCredential(owner,sessionId,taskId,"agy",{currentCredential:next.agentCredential})).toThrow(/revoked/);
   const rotatedByOperator=rotateBrainTaskAgentCredential(owner,sessionId,taskId,"agy",{operatorApproved:true,ttlMs:60000});
   expect(authorizeBrainTaskAgent(owner,sessionId,taskId,"agy",rotatedByOperator.agentCredential)).toBe(true);
 });
 it("enforces finite TTL and refuses revoked/foreign credentials",()=>{
   const {owner,sessionId,taskId}=fixture();
   expect(()=>issueBrainTaskAgentCredentials(owner,sessionId,taskId,5)).toThrow(/TTL/);
   const issued=issueBrainTaskAgentCredentials(owner,sessionId,taskId,60000);
   expect(()=>rotateBrainTaskAgentCredential(owner,sessionId,taskId,"agy",{currentCredential:issued.claude})).toThrow(/mismatch/);
   expect(()=>revokeBrainTaskAgentCredential(owner,sessionId,taskId,"agy",{currentCredential:issued.claude})).toThrow(/mismatch/);
   expect(()=>authorizeBrainTaskAgent("oauth:foreign",sessionId,taskId,"agy",issued.agy)).toThrow();
 });
});
