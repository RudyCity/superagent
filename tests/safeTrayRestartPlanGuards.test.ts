import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertTrayJournalsClear, assertTrayRestartForeignProcessFree } from "../src/core/runtime/managedTrayControl.js";
import { ManagedSidecarLedger, sidecarOperationFingerprint } from "../src/core/runtime/managedSidecarLedger.js";

const original = process.env.SUPERAGENT_CONFIG_DIR;
const roots: string[] = [];
function isolatedDir() {
  const dir=mkdtempSync(join(tmpdir(),"safe-tray-restart-"));
  roots.push(dir); process.env.SUPERAGENT_CONFIG_DIR=dir;
  return dir;
}
afterEach(()=>{
  if(original===undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=original;
  roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));
});
describe("Safe Tray restart plan guards (offline, no live process mutation)",()=>{
  it("rejects foreign Tray PID in plan and pre-stop recheck",()=>{
    expect(()=>assertTrayRestartForeignProcessFree([26588])).toThrow("TRAY_LEGACY_PROCESS_REQUIRES_USER_QUIT");
    expect(()=>assertTrayRestartForeignProcessFree([26588,26589])).toThrow("26588,26589");
    expect(()=>assertTrayRestartForeignProcessFree([])).not.toThrow();
  });
  it.each([45321,45322] as const)("rejects pending journal namespace %i even when other namespace free",port=>{
    isolatedDir();
    const ledger=new ManagedSidecarLedger("tray",port);
    ledger.begin(randomUUID(),sidecarOperationFingerprint({service:"tray",port}));
    expect(()=>assertTrayJournalsClear()).toThrow("TRAY_LIFECYCLE_UNCERTAIN_PENDING_OPERATOR_REVIEW");
  });
  it("accepts never-used journals and completed receipts without guessing process ownership",()=>{
    isolatedDir();
    expect(()=>assertTrayJournalsClear()).not.toThrow();
    const id=randomUUID(),journal=new ManagedSidecarLedger("tray",45321);
    journal.begin(id,sidecarOperationFingerprint({x:1}));
    journal.complete(id,0);
    expect(()=>assertTrayJournalsClear()).not.toThrow();
  });
});
