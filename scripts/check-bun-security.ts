/** Fail-closed Bun dependency release gate. No installs or automatic upgrades. */
import { spawnSync } from 'node:child_process';
if (!process.versions.bun) throw new Error('Run with Bun');
const result=spawnSync(process.execPath,['audit','--json'],{
 encoding:'utf8',timeout:50000,maxBuffer:12*1024*1024});
try{
 if(!result.stdout?.trim())throw new Error(result.error?.message||result.stderr||'Empty audit response');
 const parsed=JSON.parse(result.stdout);
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Invalid audit payload');
 const critical=Object.entries(parsed).flatMap(([name,items])=>
  Array.isArray(items)
   ? items.filter((item:any)=>item.severity==='high'||item.severity==='critical')
      .map((item:any)=>name+' '+item.severity+' '+(item.url||item.id||'unknown'))
   : ['Invalid advisory array for '+name]);
 console.log(JSON.stringify({status:critical.length?'blocked':'pass',
   high_critical_advisories:critical,bun_version:process.versions.bun},null,2));
 if(critical.length)process.exitCode=1;
}catch(error){
 console.error('BUN_SECURITY_GATE_UNVERIFIED',error instanceof Error?error.message:String(error));
 process.exitCode=1;
}
