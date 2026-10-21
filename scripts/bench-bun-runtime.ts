/** Read-only Bun baseline; never starts user agent or binds a port. */
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFilesInProcessPool, getProcessPoolMetrics } from '../src/core/agent/ProcessPool.js';

if (!process.versions.bun) throw new Error('Bun required');
const root=path.resolve(import.meta.dir,'..');
const sandbox=await mkdtemp(path.join(tmpdir(),'superagent-bun-bench-'));
const summarize=(nums:number[])=>{
 const sorted=[...nums].sort((a,b)=>a-b);
 return {samples:sorted.length,p50_ms:+sorted[Math.floor(sorted.length*.5)].toFixed(2),
 p95_ms:+sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)].toFixed(2)};
};
try{
 const launch:number[]=[];
 for(let i=0;i<5;i++){
  const started=performance.now();
  const result=spawnSync(process.execPath,['dist/cli.js','--version'],{
   cwd:root,timeout:12000,encoding:'utf8',
   env:{...process.env,SUPERAGENT_CONFIG_DIR:sandbox,HOME:sandbox,USERPROFILE:sandbox}});
  if(result.status!==0)throw new Error('CLI startup failed: '+result.stderr);
  launch.push(performance.now()-started);
 }
 const jobs=[];
 for(let i=0;i<16;i++){
  const filePath=path.join(sandbox,'file-'+i+'.txt');
  await writeFile(filePath,'Synthetic Bun worker data '+i+'\n');
  jobs.push({filePath,displayPath:'file-'+i,offset:1,limit:2});
 }
 const batches:number[]=[];
 for(let i=0;i<4;i++){
  const started=performance.now();
  const result=await readFilesInProcessPool(jobs,{maxWorkers:4,timeoutMs:12000});
  if(result.length!==16)throw new Error('Worker returned incorrect result count');
  batches.push(performance.now()-started);
 }
 console.log(JSON.stringify({runtime:'Bun '+process.versions.bun,
  cli_startup:summarize(launch),worker_batch_16_files:summarize(batches),
  worker_metrics:getProcessPoolMetrics(),
  process_rss_mb:+(process.memoryUsage().rss/1048576).toFixed(2),
  scope:'isolated synthetic baseline, not long-running agent soak'},null,2));
}finally{await rm(sandbox,{recursive:true,force:true});}
