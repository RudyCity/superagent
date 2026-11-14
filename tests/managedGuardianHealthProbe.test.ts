import { afterAll, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { inspectManagedGuardian } from "../src/core/runtime/managedGuardianControl.js";

const oldProfile = process.env.SUPERAGENT_CONFIG_DIR;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-health-probe-"));
process.env.SUPERAGENT_CONFIG_DIR = profile;

afterEach(() => {
  for (const file of fs.readdirSync(profile)) fs.rmSync(path.join(profile, file), { force: true });
});


describe("Guardian health transport validation", () => {
  it("retries one broken loopback probe while revalidating the exact owner", async () => {
    let calls = 0;
    const port = 27389;
    const instanceId = crypto.randomBytes(16).toString("hex");
    const server = http.createServer((req, res) => {
      calls++;
      if (calls === 1) { req.socket.destroy(); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: "superagent-managed-guardian", pid: process.pid,
        corePort: port, instanceId, guardianRegistered: true }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw Error("no listener");
    fs.writeFileSync(path.join(profile, "managed-guardian-" + port + ".json"), JSON.stringify({
      version: 1, port, pid: process.pid, instanceId,
      token: crypto.randomBytes(32).toString("hex"), controlPort: addr.port,
    }));
    try {
      const result = await inspectManagedGuardian(port);
      expect(result.verified).toBe(true);
      expect(calls).toBe(2);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 15000);

  it("never retries or trusts an identity mismatch", async () => {
    let calls = 0;
    const port = 27390;
    const instanceId = crypto.randomBytes(16).toString("hex");
    const server = http.createServer((_req, res) => {
      calls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: "superagent-managed-guardian", pid: process.pid,
        corePort: port, instanceId: "wrong", guardianRegistered: true }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw Error("no listener");
    fs.writeFileSync(path.join(profile, "managed-guardian-" + port + ".json"), JSON.stringify({
      version: 1, port, pid: process.pid, instanceId,
      token: crypto.randomBytes(32).toString("hex"), controlPort: addr.port,
    }));
    try {
      const result = await inspectManagedGuardian(port);
      expect(result.verified).toBe(false);
      expect(calls).toBe(1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 15000);
});

afterAll(() => {
  if (oldProfile === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = oldProfile;
  fs.rmSync(profile, { recursive: true, force: true });
});
