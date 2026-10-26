/**
 * Phase 5n: staging-only persisted owner lease protocol.
 * The nonce is a same-user local coordination secret, NOT an OS security boundary.
 * No public tunnel/OAuth state and no production port is ever owned here.
 */
import fs from "node:fs";
import path from "node:path";
export const MANAGED_MCP_PORTS_FORBIDDEN = new Set([6789, 7888, 7892, 9877]);
export const APPROVE_MANAGED_MCP = "START_STAGING_MCP_OWNER";
export interface ManagedMcpLease {
  version:1; kind:"managed_mcp_staging"; pid:number;port:number;nonce:string;
  createdAt:number;auth:"private_bearer";modelAutostart:false;publicTunnel:false;
}
export function assertManagedMcpPort(port:number):void {
  if(!Number.isInteger(port)||port<1024||port>65535||MANAGED_MCP_PORTS_FORBIDDEN.has(port))
    throw new Error("Refusing protected or invalid MCP staging port");
}
export function assertManagedMcpDirectory(dir:string,base:string):void {
  const resolved=path.resolve(dir),root=path.resolve(base);
  const relative=path.relative(root,resolved);
  if(!relative||relative.startsWith("..")||path.isAbsolute(relative))
    throw new Error("MCP staging owner must live beneath private staging root");
  for(const candidate of [root,resolved]) {
    const stat=fs.lstatSync(candidate);
    if(!stat.isDirectory()||stat.isSymbolicLink())
      throw new Error("Unsafe MCP staging owner directory");
  }
}
export function assertSafeRegularFile(file:string):void {
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>4096)
    throw new Error("Unsafe managed MCP metadata file");
}
export function readManagedMcpLease(profile:string):ManagedMcpLease|null {
  const file=path.join(profile,"managed-owner.json");
  try{
    assertSafeRegularFile(file);
    const v=JSON.parse(fs.readFileSync(file,"utf8")) as ManagedMcpLease;
    if(v.version!==1||v.kind!=="managed_mcp_staging"||
      !Number.isSafeInteger(v.pid)||v.pid<1||
      !Number.isInteger(v.port)||v.port<1024||v.port>65535||
      !/^[a-f0-9]{64}$/.test(v.nonce)||!Number.isSafeInteger(v.createdAt)||
      v.auth!=="private_bearer"||v.modelAutostart!==false||v.publicTunnel!==false)
      throw new Error("Invalid staging MCP lease data");
    return v;
  }catch(e) {
    if((e as NodeJS.ErrnoException).code==="ENOENT")return null;
    throw new Error("MCP owner lease corrupt or unreadable; operator review required");
  }
}
export function writeOwnedMcpLease(profile:string,v:ManagedMcpLease):void {
  fs.writeFileSync(path.join(profile,"managed-owner.json"),JSON.stringify(v)+"\n",{
    flag:"wx",mode:0o600,
  });
}
export function requestOwnedMcpStop(profile:string,lease:ManagedMcpLease):void {
  fs.writeFileSync(path.join(profile,"managed-stop.json"),JSON.stringify({
    version:1,pid:lease.pid,port:lease.port,nonce:lease.nonce,
  })+"\n",{flag:"wx",mode:0o600});
}
export function matchesOwnedMcpStop(profile:string,lease:ManagedMcpLease):boolean {
  const file=path.join(profile,"managed-stop.json");
  try {
    assertSafeRegularFile(file);
    const v=JSON.parse(fs.readFileSync(file,"utf8"));
    return v.version===1&&v.pid===lease.pid&&v.port===lease.port&&v.nonce===lease.nonce;
  }catch(e){
    if((e as NodeJS.ErrnoException).code==="ENOENT")return false;
    throw new Error("Corrupt managed MCP stop marker; no operation performed");
  }
}
export function cleanOwnMcpLease(profile:string,lease:ManagedMcpLease):void {
  const current=readManagedMcpLease(profile);
  if(current?.pid!==lease.pid||current.nonce!==lease.nonce) return;
  fs.unlinkSync(path.join(profile,"managed-owner.json"));
  if(matchesOwnedMcpStop(profile,lease))
    fs.unlinkSync(path.join(profile,"managed-stop.json"));
}
