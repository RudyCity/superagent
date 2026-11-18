import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { BrowserProcessManager } from "../src/core/browserRuntime/browserProcessManager.js";
import { readProcessStartIdentity } from "../src/core/tools/cliBridgeProcessIdentity.js";
import type { BrowserInstanceRecord } from "../src/core/browserRuntime/types.js";

describe("Managed CDP launch ownership/reuse", () => {
  let server: http.Server;
  let port: number;
  let manager: BrowserProcessManager;
  const browserPath = "/devtools/browser/owned-fixture-123";
  beforeEach(async () => {
    manager = new BrowserProcessManager();
    server = http.createServer((req,res)=>{
      res.setHeader("Content-Type","application/json");
      if(req.url === "/json/version") {
        res.end(JSON.stringify({
          Browser:"Chrome/136",webSocketDebuggerUrl:`ws://127.0.0.1:${port}${browserPath}`,
        }));
      } else if(req.url === "/json/list")res.end("[]");
      else {res.statusCode=404;res.end("{}");}
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    port=(server.address() as {port:number}).port;
  });
  afterEach(async()=>{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  });

  it("refuses to adopt an untracked listener without spawning Chrome",async()=>{
    await expect(manager.launchBrowser({port,mode:"headless"}))
      .rejects.toThrow(/MANAGED_CDP_PORT_OCCUPIED/);
  });

  it("reuses only a tracked PID and matching exact browser fingerprint",async()=>{
    const identity = await readProcessStartIdentity(process.pid);
    expect(identity).toBeTruthy();
    const dataDir=path.join(os.tmpdir(),"cdp-owner-test-"+port);
    const record:BrowserInstanceRecord={
      recordId:"owned-fixture",pid:process.pid,creationIdentity:identity,port,
      host:"127.0.0.1",mode:"headless",resolvedMode:"headless",
      executable:"chrome",userDataDir:dataDir,profileName:"Default",
      browserFingerprint:crypto.createHash("sha256").update(browserPath).digest("hex"),
      launchedAt:Date.now(),generation:"test-fixture",
    };
    (manager as any).activeInstances.set(port,record);
    const reused=await manager.launchBrowser({port,mode:"headless",userDataDir:dataDir});
    expect(reused.pid).toBe(process.pid);
    expect(reused.reused).toBe(true);

    await expect(manager.launchBrowser({
      port,mode:"headless",userDataDir:dataDir,url:"https://example.org/",
    })).rejects.toThrow(/MANAGED_CDP_ALREADY_RUNNING/);

    record.browserFingerprint="mismatch";
    await expect(manager.launchBrowser({port,mode:"headless",userDataDir:dataDir}))
      .rejects.toThrow(/MANAGED_CDP_OWNED_UNHEALTHY/);
  });
});
