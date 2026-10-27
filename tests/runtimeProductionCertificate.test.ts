import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRuntimeProductionCertificate,
  runtimeProductionCertificatePath,
  writeRuntimeProductionCertificate,
  type RuntimeProductionCertificate,
} from "../src/core/runtime/runtimeProductionCertificate.js";

const previousHome=process.env.HOME;
const previousProfile=process.env.USERPROFILE;
const roots:string[]=[];
afterEach(()=>{
  if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
  if(previousProfile===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=previousProfile;
  for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});
});

function cert(now=Date.now()):RuntimeProductionCertificate{
  return {
    version:1,corePort:7888,issuedAt:now,validUntil:now+60_000,operatorApprovedAt:now,
    rollback:{passed:true,verifiedAt:now,beforeWorkerPid:11,restartWorkerPid:12,rollbackWorkerPid:11},
    soak:{passed:true,verifiedAt:now,durationMs:30_000,restartCycles:2,mcpPidsStable:true,guardianStable:true},
    tline:{passed:true,verifiedAt:now,version:"1.0.0",verifyAllPassed:true,bundlePassed:true,guiSmokePassed:true},
  };
}
describe("runtime production certificate",()=>{
  it("round-trips a bounded complete certificate",()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"runtime-cert-"));roots.push(root);
    process.env.HOME=root;process.env.USERPROFILE=root;
    writeRuntimeProductionCertificate(cert());
    expect(readRuntimeProductionCertificate(7888)?.tline.guiSmokePassed).toBe(true);
  });
  it("fails closed on expired or incomplete evidence",()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"runtime-cert-"));roots.push(root);
    process.env.HOME=root;process.env.USERPROFILE=root;
    const file=runtimeProductionCertificatePath(7888);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,JSON.stringify({...cert(Date.now()-120_000),validUntil:Date.now()-60_000}));
    expect(readRuntimeProductionCertificate(7888)).toBeNull();
    fs.writeFileSync(file,JSON.stringify({...cert(),tline:{...cert().tline,guiSmokePassed:false}}));
    expect(readRuntimeProductionCertificate(7888)).toBeNull();
  });
});
