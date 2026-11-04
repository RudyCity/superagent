import {describe,it,expect,afterEach,vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ManagedSidecarLedger,sidecarOperationFingerprint,
} from "../src/core/runtime/managedSidecarLedger.js";
const roots:string[]=[];
afterEach(()=>{
  vi.restoreAllMocks();
  for(const root of roots.splice(0))
    fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});
});
describe("explicit owner-absent uncertain-operation review",()=>{
  it("rejects early review, never reruns a reviewed operation, allows safe repeated review",()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"lifecycle-reconcile-"));
    roots.push(root);
    const old=process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR=root;
    try{
      const ledger=new ManagedSidecarLedger("tray",45321);
      const id="unit-reconcile-op-20261105",fingerprint=sidecarOperationFingerprint({
        target:"tray",action:"start",
      });
      const baseline=Date.now();
      const now=vi.spyOn(Date,"now").mockReturnValue(baseline);
      expect(ledger.begin(id,fingerprint)).toEqual({replayed:false});
      expect(()=>ledger.reconcile(id,false,true)).toThrow("OWNER_ABSENCE");
      expect(()=>ledger.reconcile(id,true,false)).toThrow("APPROVAL");
      expect(()=>ledger.reconcile(id,true,true)).toThrow("COOLDOWN");
      now.mockReturnValue(baseline+120100);
      const receipt=ledger.reconcile(id,true,true);
      expect(receipt.state).toBe("reviewed");
      expect(receipt.executedAgain).toBe(false);
      expect(ledger.reconcile(id,true,true)).toMatchObject({
        state:"reviewed",executedAgain:false,
        operationHashPrefix:receipt.operationHashPrefix,
      });
      expect(ledger.inspect().filter(x=>x.state==="reviewed")).toHaveLength(1);
      expect(()=>ledger.begin(id,fingerprint)).toThrow("REVIEWED_NOT_REPLAYABLE");
      expect(()=>ledger.lookup(id,fingerprint)).toThrow("REVIEWED_NOT_REPLAYABLE");
    }finally{
      if(old===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR=old;
    }
  });
});
