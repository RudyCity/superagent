/** Cross-project loopback contract test, isolated and never touches port 7888. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

if (!process.versions.bun) throw new Error('Bun required');
const root=path.resolve(import.meta.dir,'..');
const target=path.resolve(root,'..','t-line','backend','src','superAgentPortProbe.ts');
await fs.access(target);
const { probeSuperAgentPort }=await import(pathToFileURL(target).href);
const config=await fs.mkdtemp(path.join(os.tmpdir(),'sa-tline-bun-bridge-'));
const port=await new Promise<number>((resolve,reject)=>{
 const socket=net.createServer();
 socket.once('error',reject);
 socket.listen(0,'127.0.0.1',()=>{
  const p=(socket.address() as net.AddressInfo).port;
  socket.close(()=>resolve(p));
 });
});
const proc=Bun.spawn([process.execPath,path.join(root,'dist','cli.js'),'--server',String(port),'--client-mode','tline'],{
 cwd:root,env:{...process.env,SUPERAGENT_CONFIG_DIR:config,HOME:config,USERPROFILE:config},
 stdout:'pipe',stderr:'pipe'
});
let childOutput='';
const drain=async (stream:any)=>{
 try{for await(const part of stream)childOutput=(childOutput+new TextDecoder().decode(part)).slice(-1800);}
 catch{/* process ended */}
};
void drain(proc.stdout);void drain(proc.stderr);
try{
 let token='';
 for(let i=0;i<60;i++){
  if(proc.exitCode!==null)break;
  try{
   const raw=JSON.parse(await fs.readFile(path.join(config,'server-info-'+port+'.json'),'utf8'));
   if(raw.port===port&&typeof raw.authToken==='string'&&/^[0-9a-f]{48}$/i.test(raw.authToken)){
    token=raw.authToken;break;
   }
  }catch{}
  await Bun.sleep(150);
 }
 if(!token)throw new Error('SuperAgent isolated token handoff failed: '+childOutput);
 const valid=await probeSuperAgentPort(port,{Authorization:'Bearer '+token});
 const invalid=await probeSuperAgentPort(port,{Authorization:'Bearer invalid'});
 const missing=await probeSuperAgentPort(port,{});
 if(valid!=='compatible'||invalid!=='occupied'||missing!=='occupied')
  throw new Error('T-Line probe contract mismatch: '+[valid,invalid,missing].join(','));
 console.log('BUN_TLINE_BRIDGE_SMOKE_OK compatible=authenticated rejected=invalid,missing');
}finally{
 try{proc.kill();}catch{}
 await Promise.race([proc.exited,Bun.sleep(1500)]);
 await fs.rm(config,{recursive:true,force:true,maxRetries:3,retryDelay:150});
}
