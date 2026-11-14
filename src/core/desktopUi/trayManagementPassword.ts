/**
 * Separate, default-disabled Tray remote-management password.
 * The password is never stored in Tray preferences, returned via IPC, logged,
 * inserted into a URL or used as native screen/input approval.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRootConfigDir } from "../config/paths.js";

export interface TrayPasswordStatus { configured:boolean; remoteEnabled:false; }
const FILENAME="tray-remote-management-password.json";
const HASH="scrypt-v1";
const PARAM={N:16384,r:8,p:1,maxmem:64*1024*1024};
const memoryAttempts=new Map<string,{count:number;until:number}>();
function defaultPath():string{return join(getRootConfigDir(),FILENAME);}
function valid(password:unknown):password is string {
  return typeof password==="string" && password.length>=12 && password.length<=128 &&
    !/[\x00-\x1f\x7f]/.test(password);
}
function digest(password:string,salt:string):Buffer {
  return scryptSync(password,Buffer.from(salt,"hex"),32,PARAM);
}
function load(file:string):{salt:string;digest:string}|null{
  if(!existsSync(file))return null;
  const info=lstatSync(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>1024)throw Error("UNSAFE_TRAY_PASSWORD_STORE");
  if(process.platform!=="win32" && (info.mode & 0o077)!==0)
    throw Error("UNSAFE_TRAY_PASSWORD_PERMISSIONS");
  const v=JSON.parse(readFileSync(file,"utf8"));
  if(v.algorithm!==HASH || typeof v.salt!=="string" || !/^[a-f0-9]{32}$/.test(v.salt) ||
     typeof v.digest!=="string" || !/^[a-f0-9]{64}$/.test(v.digest))
    throw Error("INVALID_TRAY_PASSWORD_STORE");
  return v;
}
function compare(input:string,stored:{salt:string;digest:string}):boolean{
  const actual=digest(input,stored.salt);
  try {return timingSafeEqual(actual,Buffer.from(stored.digest,"hex"));}
  finally {actual.fill(0);}
}
export class TrayManagementPassword {
  constructor(private readonly storeFile:string=defaultPath(), private readonly now:()=>number=Date.now){}
  status():TrayPasswordStatus {
    return {configured:!!load(this.storeFile),remoteEnabled:false};
  }
  set(input:{newPassword?:unknown;currentPassword?:unknown}):TrayPasswordStatus{
    if(!input||!valid(input.newPassword))throw Error("PASSWORD_MINIMUM_12_REQUIRED");
    const prior=load(this.storeFile);
    if(prior && (!valid(input.currentPassword)||!compare(input.currentPassword,prior)))
      throw Error("INVALID_CURRENT_PASSWORD");
    const salt=randomBytes(16).toString("hex");
    const hash=digest(input.newPassword,salt).toString("hex");
    mkdirSync(dirname(this.storeFile),{recursive:true,mode:0o700});
    const tmp=this.storeFile+"."+randomBytes(12).toString("hex")+".tmp";
    try {
      writeFileSync(tmp,JSON.stringify({algorithm:HASH,salt,digest:hash}),{flag:"wx",mode:0o600});
      renameSync(tmp,this.storeFile);
    } finally {try{rmSync(tmp,{force:true});}catch{}}
    memoryAttempts.clear();
    return this.status();
  }
  verify(input:unknown,identity:string):boolean{
    const key=identity.slice(0,128);
    const prior=memoryAttempts.get(key);
    if(prior && prior.until>this.now())return false;
    const stored=load(this.storeFile);
    if(!stored)return false;
    const ok=valid(input) && compare(input,stored);
    if(ok){memoryAttempts.delete(key);return true;}
    const next=(prior?.count??0)+1;
    memoryAttempts.set(key,{count:next,until:next>=5?this.now()+Math.min(900000,60000*Math.pow(2,Math.min(next-5,4))):0});
    return false;
  }
}
export const trayManagementPassword=new TrayManagementPassword();
