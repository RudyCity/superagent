/**
 * Stage 5: locally-managed Cloudflare named-tunnel configuration preflight.
 *
 * Produces a deterministic, single-hostname ingress with a 404 catch-all.
 * No DNS API, credential generation, Cloudflare login, process restart,
 * owner migration, OAuth import or quick-tunnel adoption happens here.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import {getRootConfigDir} from "../config/paths.js";

export interface McpNamedTunnelSpec {
  schemaVersion:1;
  tunnelId:string;
  hostname:string;
  credentialsFile:string;
  cloudflaredPath:string;
}
export interface NamedTunnelPlan {
  mode:"named-external";
  tunnelId:string;hostname:string;port:number;
  publicUrl:string;
  configFile:string;
  configSha256:string;
  credentialsVerified:boolean;
  cloudflaredBinaryVerified:boolean;
  dnsConfigured:false;
  externalConnectorVerified:false;
  currentQuickTunnelUnchanged:true;
}
const TUNNEL_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOST=/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function regularFile(file:string):fs.Stats{
  if(!path.isAbsolute(file))throw Error("MCP_NAMED_PATH_NOT_ABSOLUTE");
  const s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)
    throw Error("MCP_NAMED_UNSAFE_FILE");
  return s;
}
export function validateMcpNamedHostname(hostname:string):string{
  if(typeof hostname!=="string"||hostname!==hostname.toLowerCase()||
     !HOST.test(hostname)||hostname.endsWith(".trycloudflare.com")||
     hostname.endsWith(".cfargotunnel.com")||hostname==="localhost")
    throw Error("MCP_NAMED_HOSTNAME_INVALID");
  return hostname;
}
export function validateMcpNamedTunnelSpec(value:unknown):McpNamedTunnelSpec{
  if(!value||typeof value!=="object"||Array.isArray(value))
    throw Error("MCP_NAMED_SPEC_INVALID");
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(",")!==
      "cloudflaredPath,credentialsFile,hostname,schemaVersion,tunnelId"||
     v.schemaVersion!==1||typeof v.tunnelId!=="string"||
     !TUNNEL_ID.test(v.tunnelId)||typeof v.credentialsFile!=="string"||
     typeof v.cloudflaredPath!=="string")
    throw Error("MCP_NAMED_SPEC_INVALID");
  validateMcpNamedHostname(v.hostname as string);
  if(!path.isAbsolute(v.credentialsFile)||!path.isAbsolute(v.cloudflaredPath))
    throw Error("MCP_NAMED_PATH_NOT_ABSOLUTE");
  return v as unknown as McpNamedTunnelSpec;
}
export function readMcpNamedTunnelSpec(filename:string):McpNamedTunnelSpec{
  const stat=regularFile(filename);
  if(stat.size<40||stat.size>4096)
    throw Error("MCP_NAMED_SPEC_SIZE_INVALID");
  return validateMcpNamedTunnelSpec(JSON.parse(fs.readFileSync(filename,"utf8")));
}
export function validateMcpNamedTunnelCredentials(spec:McpNamedTunnelSpec):void{
  const st=regularFile(spec.credentialsFile);
  if(st.size<40||st.size>32_768)
    throw Error("MCP_NAMED_CREDENTIALS_SIZE_INVALID");
  // Parse in process, never expose or log the credential contents.
  const cred=JSON.parse(fs.readFileSync(spec.credentialsFile,"utf8")) as unknown;
  if(!cred||typeof cred!=="object"||Array.isArray(cred))
    throw Error("MCP_NAMED_CREDENTIALS_INVALID");
  const c=cred as Record<string,unknown>;
  if(c.TunnelID!==spec.tunnelId||
     typeof c.AccountTag!=="string"||!c.AccountTag||
     typeof c.TunnelSecret!=="string"||!c.TunnelSecret)
    throw Error("MCP_NAMED_CREDENTIALS_MISMATCH");
  const binary=regularFile(spec.cloudflaredPath);
  if(binary.size<1||!/^cloudflared(?:\.exe)?$/i.test(path.basename(spec.cloudflaredPath)))
    throw Error("MCP_NAMED_BINARY_INVALID");
}
export function renderMcpNamedTunnelIngress(spec:McpNamedTunnelSpec,port:number):string{
  validateMcpNamedTunnelSpec(spec);
  if(!Number.isSafeInteger(port)||port<1024||port>65535||port===7888||port===9227)
    throw Error("MCP_NAMED_PORT_INVALID");
  return YAML.stringify({
    tunnel:spec.tunnelId,
    "credentials-file":spec.credentialsFile,
    ingress:[
      {hostname:spec.hostname,service:"http://127.0.0.1:"+port},
      {service:"http_status:404"},
    ],
  });
}
export function inspectMcpNamedIngress(yaml:string,spec:McpNamedTunnelSpec,port:number):void{
  const doc=YAML.parseDocument(yaml,{uniqueKeys:true});
  if(doc.errors.length)throw Error("MCP_NAMED_INGRESS_YAML_INVALID");
  const parsed=doc.toJS();
  if(!parsed||Object.keys(parsed).sort().join(",")!==
      "credentials-file,ingress,tunnel"||
     parsed.tunnel!==spec.tunnelId||
     parsed["credentials-file"]!==spec.credentialsFile||
     !Array.isArray(parsed.ingress)||parsed.ingress.length!==2||
     Object.keys(parsed.ingress[0]).sort().join(",")!=="hostname,service"||
     parsed.ingress[0].hostname!==spec.hostname||
     parsed.ingress[0].service!=="http://127.0.0.1:"+port||
     Object.keys(parsed.ingress[1]).join(",")!=="service"||
     parsed.ingress[1].service!=="http_status:404")
    throw Error("MCP_NAMED_INGRESS_MISMATCH");
}
function configFile(port:number,root:string):string{
  return path.join(root,"mcp-named-"+port+".yml");
}
export function planMcpNamedTunnel(
  spec:McpNamedTunnelSpec,port:number,root=getRootConfigDir(),
):NamedTunnelPlan{
  validateMcpNamedTunnelSpec(spec);
  validateMcpNamedTunnelCredentials(spec);
  const config=renderMcpNamedTunnelIngress(spec,port);
  inspectMcpNamedIngress(config,spec,port);
  if(!path.isAbsolute(root))throw Error("MCP_NAMED_PROFILE_PATH_INVALID");
  return {
    mode:"named-external",tunnelId:spec.tunnelId,
    hostname:spec.hostname,port,publicUrl:"https://"+spec.hostname+"/mcp",
    configFile:configFile(port,path.resolve(root)),
    configSha256:crypto.createHash("sha256").update(config).digest("hex"),
    credentialsVerified:true,cloudflaredBinaryVerified:true,
    dnsConfigured:false,externalConnectorVerified:false,
    currentQuickTunnelUnchanged:true,
  };
}
/** Explicitly writes one private config, never modifying an existing config. */
export function stageMcpNamedTunnelConfig(
  spec:McpNamedTunnelSpec,port:number,root=getRootConfigDir(),
):NamedTunnelPlan{
  const plan=planMcpNamedTunnel(spec,port,root);
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(!fs.lstatSync(root).isDirectory()||fs.lstatSync(root).isSymbolicLink())
    throw Error("MCP_NAMED_PROFILE_UNSAFE");
  const content=renderMcpNamedTunnelIngress(spec,port);
  if(fs.existsSync(plan.configFile)){
    regularFile(plan.configFile);
    if(fs.readFileSync(plan.configFile,"utf8")!==content)
      throw Error("MCP_NAMED_REFUSE_OVERWRITE_DIFFERENT_CONFIG");
  }else{
    fs.writeFileSync(plan.configFile,content,{flag:"wx",mode:0o600});
  }
  return plan;
}
/** Re-read credentials and exact staged bytes before a separately reviewed start. */
export function verifyStagedMcpNamedTunnel(
  spec:McpNamedTunnelSpec,port:number,root=getRootConfigDir(),
):NamedTunnelPlan{
  const plan=planMcpNamedTunnel(spec,port,root);
  const config=plan.configFile;
  if(regularFile(config).size>8192)throw Error("MCP_NAMED_CONFIG_OVERSIZED");
  const current=fs.readFileSync(config,"utf8");
  inspectMcpNamedIngress(current,spec,port);
  if(crypto.createHash("sha256").update(current).digest("hex")!==plan.configSha256)
    throw Error("MCP_NAMED_CONFIG_CHANGED");
  return plan;
}
