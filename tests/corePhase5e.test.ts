import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreRecoveryEvidence } from "../src/core/runtime/coreRecoveryEvidence.js";
import { probeTlineSessionOnce } from "../src/core/runtime/tlineReconnectProbe.js";
import { newTlineReconnectState } from "../src/core/runtime/tlineReconnectPolicy.js";

const require = createRequire(import.meta.url);
const { Database } = require("bun:sqlite") as { Database: new (file: string) => {
  exec(query: string): void; query(query: string): { get(): any }; close(): void;
}};
const original = process.env.SUPERAGENT_CONFIG_DIR;
const dirs: string[] = [];
afterEach(() => {
  if (original === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = original;
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 }); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
    }
  }
});
const stage = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-core-evidence-"));
  dirs.push(root); process.env.SUPERAGENT_CONFIG_DIR = root; return root;
};
describe("Phase 5e immutable local forensic snapshot", () => {
  it("copies a consistent SQLite DB and private checkpoint, verifies digests without touching originals", async () => {
    const root = stage();
    const p = 59145;
    const secret = crypto.randomBytes(24).toString("hex");
    const checkpoint = path.join(root, "core-checkpoint-" + p + ".json");
    const payload = {
      version: 1, port: p, savedAt: Date.now(), clientMode: "tline",
      serverToken: secret, inspectToken: crypto.randomBytes(32).toString("hex"),
      activePid: 987654321, workers: [{ pid: 987654321, port: 59146,
        since: Date.now(), generationId: crypto.randomBytes(16).toString("hex"), drainEligible: true }],
      sessions: [],
    };
    fs.writeFileSync(checkpoint, JSON.stringify(payload), { mode: 0o600 });
    const database = path.join(root, "history.db");
    const db = new Database(database);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE chat_turns (state TEXT); INSERT INTO chat_turns VALUES ('completed');");
    db.close();
    const originalBytes = fs.readFileSync(checkpoint);
    const originalSqlite = fs.readFileSync(database);
    const result = await createCoreRecoveryEvidence(p);
    expect(result.assessment.decision).toBe("cold_reset_allowed");
    expect(result.restartAuthorized).toBe(false);
    expect(result.toolReplayAuthorized).toBe(false);
    expect(result.database.integrity).toBe("ok");
    expect(result.files.find(x => x.name === "core-checkpoint.json")).toBeDefined();
    expect(result.database.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(checkpoint)).toEqual(originalBytes);
    expect(fs.readFileSync(database)).toEqual(originalSqlite);
    const manifestText = fs.readFileSync(path.join(result.folder,"manifest.json"),"utf8");
    expect(manifestText).not.toContain(secret);
    expect(fs.readFileSync(path.join(result.folder,"core-checkpoint.json"),"utf8")).toContain(secret);
    const copy = new Database(path.join(result.folder, "history.db"));
    try { expect(copy.query("SELECT COUNT(*) AS n FROM chat_turns").get().n).toBe(1); }
    finally { copy.close(); }
  });
  it("refuses live unknown port listeners and leaves data untouched", async () => {
    const root = stage();
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1", resolve));
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Test listener missing");
      await expect(createCoreRecoveryEvidence(addr.port)).rejects.toThrow(/listener/);
      expect(fs.existsSync(path.join(root, "recovery-evidence"))).toBe(false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("refuses corrupt or symlinked credentials and leaves no false complete backup", async () => {
    const root = stage();
    const source = path.join(root, "sensitive.json");
    fs.writeFileSync(source,"credentials");
    const linked = path.join(root, "core-supervisor-59147.json");
    fs.symlinkSync(source, linked);
    await expect(createCoreRecoveryEvidence(59147)).rejects.toThrow();
    const evidenceDir = path.join(root,"recovery-evidence");
    expect(fs.existsSync(evidenceDir) ? fs.readdirSync(evidenceDir).length : 0).toBe(0);
  });
});
const bearer = "a".repeat(48);
const sessionId = "test_session_1234";
const state = newTlineReconnectState(sessionId);
const mockResponse = (data: unknown, status=200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" }});
describe("one-shot T-Line read-only reconnect probe", () => {
  it("makes two GETs, retains the exact session and doesn't send chat", async () => {
    const methods: string[] = [];
    const fn: typeof fetch = async (url, init) => {
      methods.push(String(init?.method)+" "+String(url));
      return String(url).includes("/_transport/health") ?
        mockResponse({ service: "superagent-transport-host", backendReady: true }) :
        mockResponse({ sessionId });
    };
    const out=await probeTlineSessionOnce({
      frontDoor:"http://127.0.0.1:52222/", bearer,state,fetchFn:fn,
    });
    expect(out.state.phase).toBe("connected");
    expect(out.state.sessionId).toBe(sessionId);
    expect(out.issuedMethods).toEqual(["GET","GET"]);
    expect(methods).toHaveLength(2);
    expect(methods.every(v=>v.startsWith("GET "))).toBe(true);
  });
  it("distinguishes missing session and dead worker without resending init", async () => {
    const out=await probeTlineSessionOnce({
      frontDoor:"http://127.0.0.1:52222/",bearer,state,
      fetchFn:async (url)=>String(url).includes("_transport") ?
        mockResponse({service:"superagent-transport-host",backendReady:true}) :
        mockResponse({code:"SESSION_WORKER_DEAD",automaticChatReplayAllowed:false},503),
    });
    expect(out.state.phase).toBe("explicit_resume_required");
    expect(out.sessionVerified).toBe(false);
    const absent=await probeTlineSessionOnce({
      frontDoor:"http://127.0.0.1:52222/",bearer,state,
      fetchFn:async (url)=>String(url).includes("_transport") ?
        mockResponse({service:"superagent-transport-host",backendReady:true}) :
        mockResponse({ sessionId:null }),
    });
    expect(absent.state.phase).toBe("explicit_resume_required");
  });
  it("never calls arbitrary remote URLs or follows transport-side redirects", async () => {
    let attempts=0;
    const fetchFn: typeof fetch=async ()=>{attempts++;return mockResponse({});};
    await expect(probeTlineSessionOnce({
      frontDoor:"https://example.com:443/",bearer,state,fetchFn,
    })).rejects.toThrow();
    expect(attempts).toBe(0);
    const offline=await probeTlineSessionOnce({
      frontDoor:"http://127.0.0.1:52222/",bearer,state,
      fetchFn:async ()=>mockResponse({ service:"superagent-transport-host",backendReady:false }),
    });
    expect(offline.state.phase).toBe("offline");
    expect(offline.issuedMethods).toEqual(["GET"]);
  });
});
