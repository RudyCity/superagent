/** Validate Bun process exit cleans only its own IPC/journal state. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (!process.versions.bun) throw new Error('Requires Bun');
const config=fs.mkdtempSync(path.join(os.tmpdir(),'superagent-bun-exit-'));
const root=path.resolve(import.meta.dir,'..');
const modulePath=path.join(root,'src','core','mcp','processJournal.ts').replaceAll('\\','/');
const code=[
 'const fs=require("node:fs"); const path=require("node:path");',
 'const root=process.env.SUPERAGENT_CONFIG_DIR;',
 'const mod=await import('+JSON.stringify(modulePath)+');',
 'mod.registerCurrentProcess("cli");',
 'fs.mkdirSync(path.join(root,"ipc"),{recursive:true});',
 'fs.writeFileSync(path.join(root,"ipc",process.pid+".json"),"[]");',
 'process.stdout.write("EXIT_CHILD_PID="+process.pid+"\\n");',
 'process.exit(0);'
].join('\n');
try{
 const result=spawnSync(process.execPath,['-e',code],{
  cwd:root,timeout:12000,encoding:'utf8',
  env:{...process.env,SUPERAGENT_CONFIG_DIR:config,HOME:config,USERPROFILE:config}});
 if(result.status!==0)throw new Error('child failed: '+result.stderr);
 const match=result.stdout.match(/EXIT_CHILD_PID=(\d+)/);
 if(!match)throw new Error('child omitted PID: '+result.stdout);
 const pid=Number(match[1]);
 if(fs.existsSync(path.join(config,'ipc',pid+'.json')))throw new Error('orphan IPC mailbox remains');
 const journal=path.join(config,'active-processes.json');
 if(fs.existsSync(journal)){
  const items=JSON.parse(fs.readFileSync(journal,'utf8'));
  if(items.some((item:any)=>item.pid===pid))throw new Error('orphan journal entry remains');
 }
 console.log('BUN_LIFECYCLE_SMOKE_OK orphan_ipc=0 orphan_journal=0');
}finally{fs.rmSync(config,{recursive:true,force:true,maxRetries:3,retryDelay:150});}
