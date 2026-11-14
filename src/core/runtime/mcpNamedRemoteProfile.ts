/**
 * Read and verify the native Tray's remote-managed Named Tunnel profile.
 * All secret material stays in a private token file; no API responses or
 * CLI output ever contain the token or its decoded Cloudflare secret.
 */
import fs from "node:fs";
import path from "node:path";
import {getRootConfigDir} from "../config/paths.js";
import {validateMcpNamedHostname} from "./mcpNamedTunnelConfig.js";

export interface RemoteManagedNamedProfile {
  version:1;
  connectorMode:"remote-managed";
  tunnelId:string;
  hostname:string;
  anchorPort:number;
  ownerPort:number;
  tokenFilePath:string;
  credentialsFilePath:"";
  cloudflaredPath:string;
}
export interface VerifiedRemoteManagedProfile {
  tunnelId:string;
  hostname:string;
  anchorPort:number;
  ownerPort:number;
  publicUrl:string;
  tokenFileVerified:true;
  cloudflaredPresent:true;
  connectorVerified:false;
  dnsVerified:false;
  clientCutoverApproved:false;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function readBoundedRegular(file:string,limit:number):Buffer{
  if(!path.isAbsolute(file))throw Error("NAMED_REMOTE_PATH_NOT_ABSOLUTE");
  const s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||
     s.size<1||s.size>limit)
    throw Error("NAMED_REMOTE_FILE_UNSAFE");
  return fs.readFileSync(file);
}
export function readRemoteManagedNamedProfile(
  root=getRootConfigDir(),
):RemoteManagedNamedProfile{
  const file=path.join(root,"mcp-named-tunnel-settings.json");
  const raw=readBoundedRegular(file,8192);
  const obj=JSON.parse(raw.toString("utf8")) as unknown;
  if(!obj||typeof obj!=="object"||Array.isArray(obj))
    throw Error("NAMED_REMOTE_PROFILE_INVALID");
  const p=obj as Partial<RemoteManagedNamedProfile>;
  if(Object.keys(p).sort().join(",")!==
      "anchorPort,cloudflaredPath,connectorMode,credentialsFilePath,hostname,ownerPort,tokenFilePath,tunnelId,version"||
     p.version!==1||p.connectorMode!=="remote-managed"||
     typeof p.tunnelId!=="string"||!uuid.test(p.tunnelId)||
     typeof p.hostname!=="string"||
     typeof p.tokenFilePath!=="string"||
     typeof p.cloudflaredPath!=="string"||
     p.credentialsFilePath!==""||
     !Number.isSafeInteger(p.anchorPort)||!Number.isSafeInteger(p.ownerPort)||
     p.anchorPort!<1024||p.anchorPort!>65535||
     p.ownerPort!<1024||p.ownerPort!>65535||
     p.anchorPort===p.ownerPort||
     [7888,9227,6759,6789,9877].includes(Number(p.anchorPort))||
     [7888,9227,6759,6789,9877].includes(Number(p.ownerPort)))
    throw Error("NAMED_REMOTE_PROFILE_INVALID");
  validateMcpNamedHostname(p.hostname);
  return p as RemoteManagedNamedProfile;
}
export function verifyRemoteManagedNamedProfile(
  root=getRootConfigDir(),
):VerifiedRemoteManagedProfile{
  const p=readRemoteManagedNamedProfile(root);
  // The operator-reviewed CLI must use the same native-imported, private
  // credential location as Tray. Reject arbitrary Downloads/shared files.
  const expected=path.join(root,"private","cloudflare-named",p.tunnelId+".token");
  if(path.resolve(p.tokenFilePath)!==path.resolve(expected))
    throw Error("NAMED_REMOTE_TOKEN_NOT_IN_PRIVATE_PROFILE");
  const parent=fs.lstatSync(path.dirname(expected));
  if(!parent.isDirectory()||parent.isSymbolicLink())
    throw Error("NAMED_REMOTE_TOKEN_DIRECTORY_UNSAFE");
  const raw=readBoundedRegular(p.tokenFilePath,4096).toString("utf8").trim();
  if(!/^eyJ[A-Za-z0-9_\-=]{60,4096}$/.test(raw))
    throw Error("NAMED_REMOTE_TOKEN_INVALID");
  let data:unknown;
  try{data=JSON.parse(Buffer.from(raw,"base64url").toString("utf8"));}
  catch{throw Error("NAMED_REMOTE_TOKEN_INVALID");}
  if(!data||typeof data!=="object"||Array.isArray(data))
    throw Error("NAMED_REMOTE_TOKEN_INVALID");
  const credential=data as Record<string,unknown>;
  if((credential.t??credential.TunnelID)!==p.tunnelId||
     typeof (credential.a??credential.AccountTag)!=="string"||
     String(credential.a??credential.AccountTag).length<8||
     typeof (credential.s??credential.TunnelSecret)!=="string"||
     String(credential.s??credential.TunnelSecret).length<8)
    throw Error("NAMED_REMOTE_TOKEN_IDENTITY_MISMATCH");
  const bin=fs.lstatSync(p.cloudflaredPath);
  if(!path.isAbsolute(p.cloudflaredPath)||!bin.isFile()||
     bin.isSymbolicLink()||bin.nlink!==1||bin.size<1||bin.size>300_000_000||
     !/^cloudflared(?:\.exe)?$/i.test(path.basename(p.cloudflaredPath)))
    throw Error("NAMED_REMOTE_CLOUDFLARED_INVALID");
  return {
    tunnelId:p.tunnelId,hostname:p.hostname,
    anchorPort:p.anchorPort,ownerPort:p.ownerPort,
    publicUrl:"https://"+p.hostname+"/mcp",
    tokenFileVerified:true,cloudflaredPresent:true,
    connectorVerified:false,dnsVerified:false,clientCutoverApproved:false,
  };
}
