/**
 * Real one-step MCP task.autostart acceptance through AGY.
 * bun scripts/brain-live-task-acceptance.ts
 * Creates no project files and never overwrites an existing Brain session.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dispatchBrainMcpTool } from '../src/core/mcp/tools/brainMcpTools.js';
import { getDelegateJob } from '../src/core/tools/cliBridgeDelegateJobs.js';
import { createBrainSession } from '../src/core/brain/brainWorkspace.js';

const principal='local-cli';
const sessionId='live_task_'+crypto.randomBytes(6).toString('hex');
createBrainSession(principal,sessionId);
const prompt='Create exactly one file called proof.txt inside the current working directory. Its exact content must be BRAIN_TASK_AUTOSTART_OK followed by a newline. Do not touch other files or repositories.';
const output=await dispatchBrainMcpTool('superagent_brain',{
 action:'task.autostart',sessionId,cli:'agy',prompt,expectedArtifacts:['proof.txt'],timeoutMs:60000
},principal);
if(!output||output.isError)throw new Error('Brain autostart failed: '+JSON.stringify(output?.content).slice(0,500));
const data=JSON.parse(output.content[0].text);
const match=String(data.delegate).match(/clj_\d+_[a-f0-9]{8,32}/);
if(!match)throw new Error('Delegation started without a recoverable job ID');
const jobId=match[0];
console.log('Task:',data.taskId,'Job:',jobId,'Session:',sessionId);
const deadline=Date.now()+62000;
let complete:Awaited<ReturnType<typeof getDelegateJob>>=null;
while(Date.now()<deadline){
 const job=await getDelegateJob(jobId);
 if(job&&['succeeded','failed','cancelled','timed_out'].includes(job.status)){complete=job;break;}
 await Bun.sleep(1200);
}
if(!complete){
 const {cliBridgeTool}=await import('../src/core/tools/cliBridgeTool.js');
 await cliBridgeTool.execute({action:'delegate.cancel',jobId},data.scratchPath);
 throw new Error('AGY job did not finish; cancellation requested, manual verification required');
}
if(complete.status!=='succeeded'||complete.completionState!=='artifacts_verified')throw new Error('AGY job did not verify: '+complete.status+' / '+complete.completionState);
const source=path.join(data.scratchPath,'proof.txt');
if(fs.readFileSync(source,'utf8').trim()!=='BRAIN_TASK_AUTOSTART_OK')throw new Error('Wrong artifact content');
const resumed=await dispatchBrainMcpTool('superagent_brain',{action:'task.resume',sessionId,taskId:data.taskId},principal);
if(!resumed||resumed.isError)throw new Error('Task could not resume');
const task=JSON.parse(resumed.content[0].text);
if(task.delegationJobs?.[0]?.jobId!==jobId)throw new Error('Delegated job was not persisted to Brain checkpoint state');
console.log('PASS: real AGY task.autostart, verified artifact and resumable task job record');
