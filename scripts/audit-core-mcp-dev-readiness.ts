/**
 * READ-ONLY readiness audit for MCP/Cloudflare + supervised Core development.
 * No tunnel stop, ownership migration, bearer rotation, or process launch.
 */
import fs from "node:fs";
import path from "node:path";
import {getRootConfigDir} from "../src/core/config/paths.js";
import {requestCoreSupervisor} from "../src/core/runtime/coreSupervisor.js";
import {readListenerOwners} from "../src/core/runtime/coreMcpOwnershipAudit.js";

function portArg(name:string,fallback:number) {
  const index=process.argv.indexOf(name);
  const value=index===-1?fallback:Number(process.argv[index+1]);
  if(!Number.isSafeInteger(value)||value<1024||value>65535)throw new Error("Invalid "+name);
  return value;
}
export function evaluateCoreMcpCutover(input:{
  publicUrl?:string;legacy:boolean;coreSupervised:boolean;kernelMcpOwnerVerified:boolean;
}) {
  const quick=typeof input.publicUrl==="string" &&
    /^https:\/\/[^/]+\.trycloudflare\.com(?:\/|$)/i.test(input.publicUrl);
  return {
    publicUrlKind:quick?"cloudflare_quick_tunnel":input.publicUrl?"other":"unknown",
    existingMcpOwnerLegacy:input.legacy,
    safeToAutoMigrate:false,
    guaranteedSameUrlAcrossLegacyMigration:false,
    canUseBackendOnlyReload:!input.legacy&&input.kernelMcpOwnerVerified,
    coreReadyForMcpRestart:input.coreSupervised,
    recommendation:input.legacy||quick
      ? "Do not replace active Legacy Quick Tunnel if its URL must remain unchanged. Set up a named Cloudflare Tunnel with owned DNS and separately approved OAuth client reauthorization; verify on an isolated port before cutover."
      : "Verify named ingress hostname/owner, OAuth credentials and connector clients separately before explicit supervised cutover.",
  };
}
async function main() {
  const mcpPort=portArg("--mcp-port",8857),corePort=portArg("--core-port",7888);
  const stateFile=path.join(getRootConfigDir(),"mcp-"+mcpPort+".json");
  let state:Record<string,unknown>|undefined;
  try {
    const stat=fs.lstatSync(stateFile);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>131072)throw new Error("unsafe file");
    state=JSON.parse(fs.readFileSync(stateFile,"utf8"));
  }catch{}
  const owners=readListenerOwners();
  const observedPid=owners?.get(mcpPort);
  const registeredPid=typeof state?.pid==="number"&&Number.isSafeInteger(state.pid)?state.pid:null;
  const ownerVerified=observedPid!==undefined && registeredPid!==null &&
    observedPid===registeredPid;
  let coreSupervised=false,corePid:number|null=null;
  try {
    const status=await requestCoreSupervisor("status",corePort,1100);
    coreSupervised=status.publicPort===corePort &&
      status.ownerContract?.role==="core-supervisor" &&
      status.ownerContract?.mcpLifecycle==="not-owned" &&
      owners?.get(corePort)===status.supervisorPid;
    corePid=status.supervisorPid;
  }catch{}
  const publicUrl=typeof state?.publicUrl==="string"?state.publicUrl:undefined;
  const legacy=state?.reloadable!==true;
  const policy=evaluateCoreMcpCutover({publicUrl,legacy,coreSupervised,
    kernelMcpOwnerVerified:ownerVerified});
  console.log(JSON.stringify({
    readOnly:true,productionChanged:false,
    mcp:{port:mcpPort,registeredPid,observedPid:observedPid??null,
      ownerVerified,authMode:state?.authMode??"unknown",publicUrl},
    core:{port:corePort,supervised:coreSupervised,pid:corePid},
    policy,
  },null,2));
}
if(import.meta.main)await main();
