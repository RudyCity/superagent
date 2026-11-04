import {describe,it,expect,afterEach,vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {CoreLifecycleLedger,coreOperationsPath,validateCoreOperationId} from "../src/core/runtime/coreLifecycleLedger.js";

const old=process.env.SUPERAGENT_CONFIG_DIR;
const dirs:string[]=[];
function isolated() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"core-operations-"));
  process.env.SUPERAGENT_CONFIG_DIR=dir;dirs.push(dir);
  return new CoreLifecycleLedger(17888);
}
afterEach(()=>{
  vi.restoreAllMocks();
  if(old===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=old;
  for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});
});
const digest="a".repeat(64);
const op=(id:string,action:"restart"|"rollback"|"drain"="restart")=>({
  id,action,expectedBuildDigest:digest,beforePid:201,
});
describe("durable and non-replayable Core lifecycle operation ledger",()=>{
  it("persists completed results, deduplicates retry and detects operation-ID conflicts",()=>{
    const ledger=isolated(),id="core-restart-unique-0001";
    const receipt=ledger.begin(op(id));
    expect(receipt.replayed).toBe(false);
    expect(ledger.inspect()[0].state).toBe("pending");
    ledger.complete(id,202);
    const recovered=new CoreLifecycleLedger(17888);
    expect(recovered.begin(op(id)).replayed).toBe(true);
    expect(recovered.begin(op(id)).receipt.afterPid).toBe(202);
    expect(()=>recovered.begin(op(id,"rollback"))).toThrow("ID_CONFLICT");
    const raw=fs.readFileSync(coreOperationsPath(17888),"utf8");
    expect(raw).not.toContain(id);
    expect(recovered.inspect()[0].operationHashPrefix).toMatch(/^[a-f0-9]{16}$/);
  });
  it("fails closed on a pending operation across process crash and requires explicit operator review",()=>{
    const ledger=isolated(),id="core-pending-unique-001";
    ledger.begin(op(id));
    const recovered=new CoreLifecycleLedger(17888);
    expect(()=>recovered.begin(op(id))).toThrow("UNCERTAIN_PENDING");
    expect(()=>recovered.begin(op("core-another-unique-002"))).toThrow("UNCERTAIN_PENDING");
    expect(()=>recovered.reconcilePending(id,202,202,true)).toThrow("ATTESTATION_REQUIRED");
    const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+121000);
    expect(()=>recovered.reconcilePending(id,999,202,true)).toThrow("ATTESTATION_REQUIRED");
    expect(recovered.reconcilePending(id,202,202,true).executedAgain).toBe(false);
    expect(new CoreLifecycleLedger(17888).inspect()[0].errorCode).toBe("OPERATOR_RECONCILED_UNKNOWN");
    expect(recovered.begin(op("core-another-unique-002")).replayed).toBe(false);
  });
  it("enforces restart cooldown and rejects malformed IDs and corrupted receipts",()=>{
    const ledger=isolated(),id="core-cooldown-unique-0001";
    ledger.begin(op(id));ledger.complete(id,202);
    expect(()=>ledger.begin(op("core-cooldown-unique-0002"))).toThrow("COOLDOWN");
    expect(()=>validateCoreOperationId("short")).toThrow("ID_REQUIRED");
    const file=coreOperationsPath(17888);
    fs.writeFileSync(file,'{"version":1,"port":17888,"operations":[{"bad":true}]}');
    expect(()=>new CoreLifecycleLedger(17888)).toThrow("CORE_LEDGER_CORRUPT");
  });
});
