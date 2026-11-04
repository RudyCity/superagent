import {describe,it,expect,afterEach} from "vitest";
import fs from "node:fs";
import os from "node:os";
import {ManagedSidecarLedger,sidecarOperationFingerprint}
  from "../src/core/runtime/managedSidecarLedger.js";

const previous=process.env.SUPERAGENT_CONFIG_DIR;
const dirs:string[]=[];
function create(){
  const dir=fs.mkdtempSync(os.tmpdir()+"/sidecar-receipts-");
  process.env.SUPERAGENT_CONFIG_DIR=dir;
  dirs.push(dir);
  return new ManagedSidecarLedger("transport",19943);
}
afterEach(()=>{
  for(const dir of dirs.splice(0))fs.rmSync(dir,{force:true,recursive:true});
  if(previous===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=previous;
});
describe("sidecar operation journal",()=>{
  it("persistently deduplicates a completed start and rejects reused ID with new expectations",()=>{
    const journal=create(),id="sidecar-verified-start-00001";
    const fp=sidecarOperationFingerprint({action:"start",port:19943});
    expect(journal.lookup(id,fp)).toBeNull();
    expect(journal.begin(id,fp).replayed).toBe(false);
    journal.complete(id,22442);
    const fresh=new ManagedSidecarLedger("transport",19943);
    expect(fresh.begin(id,fp)).toEqual({replayed:true,afterPid:22442});
    expect(()=>fresh.begin(id,sidecarOperationFingerprint({action:"stop"})))
      .toThrow("SIDECAR_OPERATION_ID_CONFLICT");
    expect(fs.readFileSync(journal.file,"utf8")).not.toContain(id);
  });
  it("fails closed after crash rather than retry an ambiguous stop",()=>{
    const journal=create(),id="sidecar-unknown-stop-0001";
    const fp=sidecarOperationFingerprint({action:"stop",port:19943});
    journal.begin(id,fp);
    const recovered=new ManagedSidecarLedger("transport",19943);
    expect(()=>recovered.lookup(id,fp)).toThrow("SIDECAR_OPERATION_UNCERTAIN_PENDING");
    expect(()=>recovered.begin("sidecar-unrelated-op-0002",fp))
      .toThrow("SIDECAR_OPERATION_UNCERTAIN_PENDING");
  });
});
