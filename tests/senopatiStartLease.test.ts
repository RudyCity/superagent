import {describe,it,expect} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireSenopatiModelStartLease,MODEL_START_LEASE_STALE_MS,
  modelStartLeaseBlocksNewModel,
}
  from "../src/core/senopatiStartLease.js";

function ephemeral(test:(file:string)=>void):void {
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),"senopati-lease-"));
 try {test(path.join(folder,"startup.lock"));}
 finally {fs.rmSync(folder,{recursive:true,force:true});}
}
describe("Senopati V6.9 exclusive startup lease",()=>{
 it("gives exactly one process permission to initialize model weights",()=>{
  ephemeral(file=>{
   const lease=acquireSenopatiModelStartLease({file});
   expect(fs.existsSync(file)).toBe(true);
   expect(()=>acquireSenopatiModelStartLease({file})).toThrow(/owned/);
   lease.release();
   expect(fs.existsSync(file)).toBe(false);
   lease.release();
   const next=acquireSenopatiModelStartLease({file});
   next.release();
  });
 });
 it("recovers ONLY a provably dead and expired owner",()=>{
  ephemeral(file=>{
   const now=Date.now();
   fs.writeFileSync(file,JSON.stringify({
     version:1,pid:2147483600,
     startedAt:now-MODEL_START_LEASE_STALE_MS-1000,
     nonce:"a".repeat(32),
   }));
   const lease=acquireSenopatiModelStartLease({file,now:()=>now});
   expect(JSON.parse(fs.readFileSync(file,"utf8")).pid).toBe(process.pid);
   lease.release();
  });
 });
 it("never steals a lease belonging to a live process even if old",()=>{
  ephemeral(file=>{
   const now=Date.now();
   fs.writeFileSync(file,JSON.stringify({
     version:1,pid:process.pid,startedAt:now-120_000,nonce:"b".repeat(32),
   }));
   expect(()=>acquireSenopatiModelStartLease({file,now:()=>now})).toThrow(/owned/);
  });
 });
 it("does not steal a recently created lease from a dead owner",()=>{
  ephemeral(file=>{
   const now=Date.now();
   fs.writeFileSync(file,JSON.stringify({
     version:1,pid:2147483600,startedAt:now-100,nonce:"c".repeat(32),
   }));
   expect(()=>acquireSenopatiModelStartLease({file,now:()=>now})).toThrow(/owned/);
  });
 });
 it("fails closed on unknown/corrupt or symlinked lease",()=>{
  ephemeral(file=>{
   fs.writeFileSync(file,"malformed");
   expect(()=>acquireSenopatiModelStartLease({file})).toThrow(/owned/);
  });
  if(process.platform!=="win32"){
   ephemeral(file=>{
    const target=file+".target";
    fs.writeFileSync(target,"target");
    fs.symlinkSync(target,file);
    expect(()=>acquireSenopatiModelStartLease({file})).toThrow(/owned/);
   });
  }
 });
 it("blocks replacement while a live owner is loading or draining",()=>{
  ephemeral(file=>{
   expect(modelStartLeaseBlocksNewModel({file})).toBe(false);
   const lease=acquireSenopatiModelStartLease({file});
   expect(modelStartLeaseBlocksNewModel({file})).toBe(true);
   lease.release();
   expect(modelStartLeaseBlocksNewModel({file})).toBe(false);
  });
 });
 it("blocks recent dead owner but allows watchdog after crash lease expires",()=>{
  ephemeral(file=>{
   const now=Date.now();
   fs.writeFileSync(file,JSON.stringify({
    version:1,pid:2147483600,startedAt:now,
    nonce:"e".repeat(32),
   }));
   expect(modelStartLeaseBlocksNewModel({file,now:()=>now+500})).toBe(true);
   expect(modelStartLeaseBlocksNewModel({
    file,now:()=>now+MODEL_START_LEASE_STALE_MS+1000,
   })).toBe(false);
  });
 });
 it("fails closed on malformed lease metadata during watchdog recovery",()=>{
  ephemeral(file=>{
   fs.writeFileSync(file,"invalid");
   expect(modelStartLeaseBlocksNewModel({file})).toBe(true);
   expect(()=>acquireSenopatiModelStartLease({file})).toThrow();
  });
 });
 it("does not erase another owner's overwritten lease on release",()=>{
  ephemeral(file=>{
   const lease=acquireSenopatiModelStartLease({file});
   fs.writeFileSync(file,JSON.stringify({
     version:1,pid:process.pid,startedAt:Date.now(),nonce:"d".repeat(32),
   }));
   lease.release();
   expect(fs.existsSync(file)).toBe(true);
  });
 });
});
