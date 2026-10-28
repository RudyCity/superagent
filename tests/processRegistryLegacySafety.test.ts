import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessRegistry, getRuntimeGeneration } from "../src/core/process/processRegistry.js";
import { scanManagedProcessOrphans } from "../src/core/process/processOrphanScanner.js";
const WS="D:/legacy-test-workspace";
describe("M1 legacy process registry migration remains fail-closed",()=>{
  it("does not infer cleanup-eligible lifecycle for pre-M2 records",async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"process-legacy-"));
    const file=path.join(dir,"registry.json");
    try {
      const raw = { version:1, savedAt:Date.now(), runtimeGeneration:getRuntimeGeneration(), records:[{
        recordId:"legacy_runtime_node", pid:44511, parentPid:111,
        creationIdentity:"win:638000000000000000", executable:"node.exe",
        sanitizedArgs:["agent.js"], runtimeGeneration:getRuntimeGeneration(),
        component:"cli_bridge", launchIntent:"headless", state:"running",
        cleanupPolicy:"automatic", ownership:{ workspaceRoot:WS, jobId:"old_job" },
        exitCode:null,signal:null,registeredAt:Date.now()-60000,
        updatedAt:Date.now()-60000,heartbeatAt:Date.now()-60000,
      }]};
      await fs.writeFile(file,JSON.stringify(raw));
      const registry=new ProcessRegistry({storagePath:file});
      expect((await registry.load()).success).toBe(true);
      expect(registry.getRecord("legacy_runtime_node")?.lifecycle).toBe("unknown");
      const report=await scanManagedProcessOrphans(registry,{callerWorkspaceRoot:WS},{
        observePid:()=> "pid_present_unverified",
        readIdentity:async()=> "win:638000000000000000",
        inspectOwner:async()=> ({state:"terminal",source:"confirmed_ended"}),
      });
      expect(report.counts.orphan_candidate).toBe(0);
      expect(report.counts.unknown).toBe(1);
    } finally {await fs.rm(dir,{recursive:true,force:true});}
  });
});
