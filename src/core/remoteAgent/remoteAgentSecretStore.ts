import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getRootConfigDir } from "../config/paths.js";

type SecretRecord = {
  kind: "dpapi-current-user" | "file-0600";
  payload: string;
  updatedAt: number;
};
type SecretFile = { version: 1; secrets: Record<string,SecretRecord> };

const FILE_NAME="remote-agent-secrets.json";
const MAX_FILE_BYTES=64*1024;

function filePath(){ return path.join(getRootConfigDir(),FILE_NAME); }

function readFile():SecretFile{
  const file=filePath();
  try{
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE_BYTES)
      throw new Error("REMOTE_SECRET_FILE_UNSAFE");
    const parsed=JSON.parse(fs.readFileSync(file,"utf8")) as SecretFile;
    if(parsed?.version!==1||!parsed.secrets||typeof parsed.secrets!=="object")
      throw new Error("REMOTE_SECRET_FILE_INVALID");
    return parsed;
  }catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")
      return {version:1,secrets:{}};
    if(error instanceof SyntaxError) throw new Error("REMOTE_SECRET_FILE_INVALID");
    throw error;
  }
}

function writeFile(data:SecretFile){
  const root=getRootConfigDir();
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const file=filePath();
  if(fs.existsSync(file)){
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()) throw new Error("REMOTE_SECRET_FILE_UNSAFE");
  }
  const temp=file+"."+process.pid+".tmp";
  fs.writeFileSync(temp,JSON.stringify(data,null,2),{encoding:"utf8",mode:0o600,flag:"w"});
  try{fs.chmodSync(temp,0o600)}catch{}
  fs.renameSync(temp,file);
  try{fs.chmodSync(file,0o600)}catch{}
}

function runPowerShell(script:string,input:string):string{
  const candidates=["powershell.exe","powershell"];
  let last="";
  for(const exe of candidates){
    const result=spawnSync(exe,["-NoLogo","-NoProfile","-NonInteractive","-Command",script],{
      encoding:"utf8",input,windowsHide:true,timeout:8000,maxBuffer:1024*1024,
    });
    if(result.status===0){
      const out=String(result.stdout||"").trim();
      if(out) return out;
    }
    last=String(result.stderr||result.error?.message||"");
  }
  throw new Error("REMOTE_SECRET_DPAPI_UNAVAILABLE"+(last?": "+last.slice(0,120):""));
}

function protectDpapi(value:string){
  // On Windows, ConvertFrom-SecureString without an explicit key is bound to
  // the current Windows user through DPAPI. The plaintext enters via stdin,
  // never through argv or the process command line.
  const script=[
    "$v=[Console]::In.ReadToEnd();",
    "$s=ConvertTo-SecureString $v -AsPlainText -Force;",
    "ConvertFrom-SecureString $s"
  ].join("");
  return runPowerShell(script,value);
}
function unprotectDpapi(payload:string){
  const script=[
    "$v=[Console]::In.ReadToEnd();",
    "$s=ConvertTo-SecureString $v;",
    "$c=New-Object System.Net.NetworkCredential('', $s);",
    "$c.Password"
  ].join("");
  return runPowerShell(script,payload);
}

export function storeRemoteAgentSecret(name:string,value:string):string{
  if(!/^[a-z0-9_.-]{3,64}$/i.test(name)) throw new Error("REMOTE_SECRET_NAME_INVALID");
  if(typeof value!=="string"||value.length<1||value.length>4096) throw new Error("REMOTE_SECRET_VALUE_INVALID");
  const data=readFile();
  const record:SecretRecord=process.platform==="win32"
    ? {kind:"dpapi-current-user",payload:protectDpapi(value),updatedAt:Date.now()}
    : {kind:"file-0600",payload:Buffer.from(value,"utf8").toString("base64"),updatedAt:Date.now()};
  data.secrets[name]=record;
  writeFile(data);
  return name;
}

export function loadRemoteAgentSecret(name:string):string|undefined{
  const record=readFile().secrets[name];
  if(!record) return undefined;
  if(record.kind==="dpapi-current-user"){
    if(process.platform!=="win32") throw new Error("REMOTE_SECRET_DPAPI_WRONG_PLATFORM");
    return unprotectDpapi(record.payload);
  }
  if(record.kind==="file-0600"){
    return Buffer.from(record.payload,"base64").toString("utf8");
  }
  throw new Error("REMOTE_SECRET_KIND_UNSUPPORTED");
}

export function deleteRemoteAgentSecret(name:string):boolean{
  const data=readFile();
  if(!data.secrets[name]) return false;
  delete data.secrets[name];
  writeFile(data);
  return true;
}

export function inspectRemoteAgentSecret(name:string){
  const record=readFile().secrets[name];
  return {
    configured:Boolean(record),
    storage:record?.kind??"none",
    platformProtected:record?.kind==="dpapi-current-user",
  };
}
