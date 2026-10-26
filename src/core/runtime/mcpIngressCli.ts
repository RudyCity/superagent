import {startVerifiedMcpIngress} from "./mcpIngressStage.js";
export async function runMcpIngressStage(args:string[]):Promise<void>{
  if(process.env.SUPERAGENT_MCP_INGRESS_STAGING!=="1"||
     process.env.SUPERAGENT_CORE_STAGING!=="1"||
     process.env.SUPERAGENT_SENOPATI_AUTOSTART!=="0")
    throw new Error("Ingress owner requires explicit staging mode");
  const names=["--listen-port","--target-port","--target-pid"];
  if(args.length!==6||names.some(n=>!args.includes(n)))
    throw new Error("Usage: mcp ingress-stage --listen-port PORT --target-port PORT --target-pid PID");
  const val=(n:string)=>Number(args[args.indexOf(n)+1]);
  const {proof,close}=await startVerifiedMcpIngress({
    ingressPort:val("--listen-port"),targetPort:val("--target-port"),
    targetPid:val("--target-pid"),
  });
  console.log(JSON.stringify({type:"independent_ingress_stage_ready",
    ...proof,canCutoverProduction:false,oauthTransferred:false}));
  let stopped=false;
  const shutdown=async()=>{if(stopped)return;stopped=true;await close();process.exit(0)};
  process.once("SIGTERM",()=>{void shutdown()});
  process.once("SIGINT",()=>{void shutdown()});
}
