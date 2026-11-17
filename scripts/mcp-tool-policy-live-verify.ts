/**
 * Attended, read-only MCP policy acceptance on the real independently owned host.
 * No process adoption, activation, file reads, CDP commands or grant mutations.
 *
 * SUPERAGENT_MCP_POLICY_LIVE_ACCEPTANCE=1
 * SUPERAGENT_MCP_POLICY_URL=https://reviewed-host.example/mcp
 * SUPERAGENT_MCP_POLICY_BEARER_TOKEN=<host-provided-token>
 * SUPERAGENT_MCP_POLICY_PORT=<verified-owner-port>
 * SUPERAGENT_MCP_POLICY_EXPECTED_RELEASE_DIGEST=<64-char-sha256-of-staged-mcp-backend>
 * bun scripts/mcp-tool-policy-live-verify.ts
 *
 * Does not print bearer tokens, URLs or tool output.
 */
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {manageServices} from "../src/core/runtime/serviceManager.js";
import {assessDesktopMcpOwnerEvidence,isSameVerifiedMcpGeneration,type McpServiceEvidence}
  from "../src/core/desktopUi/liveActivationGate.js";
import {classifyLiveMcpFailure,type LiveVerificationPhase}
  from "../src/core/mcp/mcpLiveVerifierDiagnostics.js";

let livePhase:LiveVerificationPhase="preflight";

function blocked(code:string,details?:string):never{
  process.stderr.write(JSON.stringify({status:"BLOCKED",code,phase:livePhase,
    ...(details?{details:details.slice(0,256)}:{})})+"\n");
  process.exit(2);
}
async function timeout<T>(p:Promise<T>,ms:number):Promise<T>{
  let id:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([p,new Promise<never>((_,reject)=>{
    id=setTimeout(()=>reject(Object.assign(new Error("MCP_POLICY_DEADLINE"),
      {code:"MCP_POLICY_DEADLINE"})),ms);
  })]);}
  finally{if(id)clearTimeout(id);}
}
async function owner(action:"status"|"doctor",port:number):Promise<McpServiceEvidence|undefined>{
  const result=await timeout(manageServices({action,service:"mcp",port}),15000);
  return (result as {services?:McpServiceEvidence[]}).services?.find(s=>s.service==="mcp");
}
async function main(){
  if(process.env.SUPERAGENT_MCP_POLICY_LIVE_ACCEPTANCE!=="1")
    blocked("OPERATOR_OPT_IN_REQUIRED");
  const rawUrl=process.env.SUPERAGENT_MCP_POLICY_URL?.trim();
  const token=process.env.SUPERAGENT_MCP_POLICY_BEARER_TOKEN?.trim();
  const port=Number(process.env.SUPERAGENT_MCP_POLICY_PORT||"9227");
  const expectedDigest=process.env.SUPERAGENT_MCP_POLICY_EXPECTED_RELEASE_DIGEST?.trim();
  if(!rawUrl||!token)blocked("URL_AND_AUTH_REQUIRED");
  if(!expectedDigest||!/^[a-f0-9]{64}$/.test(expectedDigest))
    blocked("ATTESTED_RELEASE_DIGEST_REQUIRED");
  if(!Number.isSafeInteger(port)||port<1024||port>65535)
    blocked("INVALID_OWNER_PORT");
  let url:URL;
  try{url=new URL(rawUrl);}catch{blocked("INVALID_MCP_URL");}
  if(!["http:","https:"].includes(url.protocol)||
     (url.protocol==="http:"&&!["localhost","127.0.0.1","[::1]"].includes(url.hostname))||
     url.username||url.password||url.search||url.hash||url.pathname!=="/mcp")
    blocked("UNSAFE_MCP_URL");
  livePhase="owner";
  const evidence=assessDesktopMcpOwnerEvidence(
    await owner("status",port),await owner("doctor",port),url.href,expectedDigest);
  if(!evidence.ready)blocked("UNVERIFIED_MCP_OWNER",evidence.reasons.join(","));
  const client=new Client({name:"mcp-policy-live-attested",version:"1.0.0"},
    {capabilities:{}});
  try{
    livePhase="mcp_connect";
    await timeout(client.connect(new StreamableHTTPClientTransport(url,{
      requestInit:{headers:{Authorization:"Bearer "+token}},
    })),15000);
    livePhase="mcp_catalog";
    const response=await timeout(client.listTools(),15000);
    const has=(name:string)=>response.tools.some(t=>t.name===name);
    for(const required of ["superagent_tool_search","superagent_tool_describe",
      "superagent_tool_status","superagent_tool_execute"]){
      if(!has(required))blocked("INCOMPLETE_MCP_TOOL_CATALOG");
    }
    const statusTool=response.tools.find(t=>t.name==="superagent_tool_status");
    const meta=statusTool?._meta as {filePolicy?:{active?:boolean;readiness?:string};
      mcpApproval?:{kind?:string}}|undefined;
    if(!meta?.filePolicy||!meta?.mcpApproval)
      blocked("FILE_POLICY_METADATA_MISSING");
    livePhase="mcp_status";
    const status=await timeout(client.callTool({
      name:"superagent_tool_status",arguments:{},
    }),15000);
    if(status.isError)blocked("MCP_TOOL_STATUS_FAILED");
    const text=status.content.find(x=>x.type==="text");
    if(!text||text.type!=="text")blocked("MCP_TOOL_STATUS_NOT_TEXT");
    let parsed:any;
    try{parsed=JSON.parse(text.text);}catch{blocked("MCP_TOOL_STATUS_NOT_JSON");}
    if(parsed?.filePolicy?.active!==meta.filePolicy.active||
       typeof parsed?.visibleToolCount!=="number")
      blocked("MCP_POLICY_STATUS_MISMATCH");
    // The verified backend must still be the same after the MCP requests.
    // A reload while listing tools invalidates the acceptance result.
    livePhase="owner_postflight";
    const postflight=assessDesktopMcpOwnerEvidence(
      await owner("status",port),await owner("doctor",port),url.href,expectedDigest);
    if(!isSameVerifiedMcpGeneration(evidence,postflight))
      blocked("MCP_OWNER_CHANGED_DURING_ACCEPTANCE",postflight.reasons.join(","));
    process.stdout.write(JSON.stringify({
      status:"PASS",verifiedThrough:"attested-live-mcp-http",
      verifiedScope:"read-only-catalog-and-policy",
      ownerPid:evidence.ownerPid,backendPid:evidence.backendPid,
      releaseDigestPrefix:expectedDigest.slice(0,16),
      catalogCount:parsed.visibleToolCount,
      filePolicyActive:meta.filePolicy.active,
      warnings:evidence.warnings,
      note:"No file, Desktop Input, Chrome/CDP or device actions were attempted.",
    })+"\n");
  }finally{
    await timeout(client.close().catch(()=>undefined),5000).catch(()=>undefined);
  }
}
main().catch((err:unknown)=>{
  blocked(classifyLiveMcpFailure(err));
});
