import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

vi.mock("../src/core/tools/cliBridgeTool.js", () => ({
  cliBridgeTool: { execute: vi.fn(async () => ({ ok: true })) },
}));
import { dispatchBrainMcpTool, dispatchBrainPublishMcpTool } from "../src/core/mcp/tools/brainMcpTools.js";
import { createBrainSession } from "../src/core/brain/brainWorkspace.js";

const roots: string[] = [];
function root(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "brain-mcp-storage-"));
  roots.push(r);
  process.env.SUPERAGENT_CONFIG_DIR = r;
  return r;
}
function parse(reply: any): any {
  const text = reply?.content?.[0]?.text;
  if (reply?.isError) return { error: text };
  return JSON.parse(text);
}
const call = async (principal: string, action: string, args: Record<string, unknown> = {}) =>
  parse(await dispatchBrainMcpTool("superagent_brain", { action, ...args }, principal, "auto_session"));
const publish = (principal: string, projectRoot: string, action: string, args: Record<string, unknown>) =>
  parse(dispatchBrainPublishMcpTool("superagent_brain_publish", { action, ...args }, principal, projectRoot));
afterEach(() => {
  delete process.env.SUPERAGENT_CONFIG_DIR;
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
describe("SuperAgent MCP Brain storage parity", () => {
  it("exposes owner-scoped operation metrics without leaking another principal", async () => {
    root();
    await call("oauth:metric-owner", "create");
    await call("oauth:metric-owner", "artifact.import", { filename: "tiny.pdf", base64: Buffer.from("tiny").toString("base64") });
    await call("oauth:metric-owner", "artifact.import", { filename: "tiny.pdf", base64: Buffer.from("tiny").toString("base64") });
    const metrics = await call("oauth:metric-owner", "metrics");
    expect(metrics.events).toBe(2);
    expect(metrics.failures).toBe(1);
    expect(metrics.types.find((item: any) => item.event === "artifact.import").failures).toBe(1);
    expect((await call("oauth:other", "metrics")).events).toBe(0);
    expect(JSON.stringify(metrics)).not.toContain("tiny.pdf");
  });
  it("returns owner-scoped usage and imports/downloads a binary in bounded chunks", async () => {
    root();
    const principal = "oauth:alice";
    const current = await call(principal, "current");
    expect(current.sessionId).toBe("auto_session");
    const bytes = Buffer.concat([Buffer.from("PNG"), Buffer.alloc(300_000, 31)]);
    const imported = await call(principal, "artifact.import", {
      filename: "image.png", base64: bytes.toString("base64"),
    });
    expect(imported.success).toBe(true);
    expect(imported.bytes).toBe(bytes.length);
    const usage = await call(principal, "storage");
    expect(usage.totalBytes).toBe(bytes.length);
    expect(usage.areas.find((a: any) => a.area === "artifacts").files).toBe(1);
    const chunkA = await call(principal, "artifact.read", { filePath: "artifacts/image.png" });
    expect(chunkA.length).toBe(256 * 1024);
    expect(chunkA.done).toBe(false);
    const chunkB = await call(principal, "artifact.read", { filePath: "artifacts/image.png", offset: chunkA.nextOffset });
    expect(chunkB.done).toBe(true);
    expect(Buffer.concat([Buffer.from(chunkA.base64, "base64"), Buffer.from(chunkB.base64, "base64")])).toEqual(bytes);
    const other = await call("oauth:bob", "artifact.read", {
      sessionId: current.sessionId, filePath: "artifacts/image.png",
    });
    expect(other.error).toMatch(/not found/i);
  });

  it("rejects invalid payloads, traversal, overwrite, and unsafe binary access", async () => {
    root();
    await call("oauth:a", "create");
    for (const payload of [
      { filename: "../secret.png", base64: Buffer.from("1").toString("base64") },
      { filename: "program.exe", base64: Buffer.from("1").toString("base64") },
      { filename: "image.png", base64: "!bad" },
    ]) {
      expect((await call("oauth:a", "artifact.import", payload)).error).toBeTruthy();
    }
    const png = Buffer.from("valid");
    expect((await call("oauth:a", "artifact.import", { filename: "okay.png", base64: png.toString("base64") })).success).toBe(true);
    expect((await call("oauth:a", "artifact.import", { filename: "okay.png", base64: png.toString("base64") })).error).toMatch(/exist|already|EEXIST/i);
    for (const badPath of ["../manifest.json", "scratch/x.png", "artifacts/../manifest.json", "artifacts/.env"]) {
      expect((await call("oauth:a", "artifact.read", { filePath: badPath })).error).toBeTruthy();
    }
    expect((await call("oauth:a", "artifact.read", { filePath: "artifacts/okay.png", offset: -1 })).error).toBeTruthy();
    expect((await call("oauth:a", "artifact.read", { filePath: "artifacts/okay.png", offset: 99999999 })).error).toBeTruthy();
  });

  it("requires one-time cleanup approval, protects artifacts and rejects replay or changed scratch", async () => {
    root();
    await call("oauth:a", "create");
    await call("oauth:a", "write", { filePath: "scratch/temp.txt", content: "temporary" });
    await call("oauth:a", "write", { filePath: "artifacts/final.txt", content: "retained" });
    expect((await call("oauth:a", "cleanup")).error).toMatch(/retired/);
    const preview = await call("oauth:a", "cleanup.prepare");
    expect(preview.preview.files).toBe(1);
    expect(preview.preview.retained).toContain("artifacts/");
    expect((await call("oauth:b", "cleanup.confirm", { sessionId: "auto_session", challenge: preview.challenge })).error).toBeTruthy();
    // A bad owner cannot consume an actual owner's confirmation.
    const changed = await call("oauth:a", "cleanup.confirm", { challenge: preview.challenge });
    expect(changed.success).toBe(true);
    expect((await call("oauth:a", "cleanup.confirm", { challenge: preview.challenge })).error).toBeTruthy();
    expect((await call("oauth:a", "read", { filePath: "artifacts/final.txt" })).content).toBe("retained");
    expect((await call("oauth:a", "read", { filePath: "scratch/temp.txt" })).error).toBeTruthy();
    await call("oauth:a", "write", { filePath: "scratch/temp.txt", content: "old" });
    const pending = await call("oauth:a", "cleanup.prepare");
    await call("oauth:a", "write", { filePath: "scratch/temp.txt", content: "changed", overwrite: true });
    expect((await call("oauth:a", "cleanup.confirm", { challenge: pending.challenge })).error).toMatch(/changed/i);
  });

  it("blocks cleanup while persisted delegation is active and offers dry-run retention", async () => {
    const r = root();
    const principal = "oauth:owner";
    const session = createBrainSession(principal, "old_session");
    fs.writeFileSync(path.join(session.scratchPath, "old.txt"), "keep");
    const filePath = path.join(session.scratchPath, "old.txt");
    const old = new Date(Date.now() - 40 * 86_400_000);
    fs.utimesSync(filePath, old, old);
    const preview = await call(principal, "retention.preview", { days: 30 });
    expect(preview.autoDelete).toBe(false);
    expect(preview.candidates.map((v: any) => v.sessionId)).toContain("old_session");
    expect(fs.readFileSync(filePath, "utf8")).toBe("keep");
    const jobId = "clj_1792638000000_deadbeef";
    const jobRoot = path.join(r, "cli-bridge", "delegations", "jobs.d", jobId);
    fs.mkdirSync(jobRoot, { recursive: true });
    const snapshot = path.join(jobRoot, "1792638000000-0000000001-0123456789abcdef.json");
    fs.writeFileSync(snapshot, JSON.stringify({ jobId, cwd: session.scratchPath, status: "running" }));
    expect((await call(principal, "cleanup.prepare", { sessionId: "old_session" })).error).toMatch(/delegation/i);
    fs.writeFileSync(snapshot, JSON.stringify({ jobId, cwd: session.scratchPath, status: "succeeded" }));
    expect((await call(principal, "cleanup.prepare", { sessionId: "old_session" })).preview.files).toBe(1);
  });

  it("blocks scratch cleanup while an AGY job writes in nested task scratch", async () => {
    const config = root();
    const owner = "oauth:nested-owner";
    const session = createBrainSession(owner, "nested_session");
    const nested = path.join(session.scratchPath, "agents", "agy", "task_0123456789abcdefabcd");
    fs.mkdirSync(nested, { recursive:true });
    const other = path.join(session.path, "scratch-sibling");
    fs.mkdirSync(other);
    const shard = path.join(config, "cli-bridge", "delegations", "jobs.d");
    const stamp = "1792638000000-0000000001-0123456789abcdef.json";
    const nestedId = "clj_1792638000000_abcd1234";
    const siblingId = "clj_1792638000000_aabb1122";
    for (const [id,cwd] of [[nestedId,nested],[siblingId,other]]) {
      const dir=path.join(shard,id);
      fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,stamp),JSON.stringify({jobId:id,cwd,status:"running"}));
    }
    expect((await call(owner,"cleanup.prepare",{sessionId:"nested_session"})).error).toMatch(/delegation/i);
    fs.writeFileSync(path.join(shard,nestedId,stamp),JSON.stringify({jobId:nestedId,cwd:nested,status:"succeeded"}));
    expect((await call(owner,"cleanup.prepare",{sessionId:"nested_session"})).preview).toBeTruthy();
  });

  it("binds binary publish to owner/root/file/hash, refuses foreign token, overwrite, and replay", async () => {
    const r = root();
    const principal = "oauth:publish-a";
    await call(principal, "create");
    const png = Buffer.from([137, 80, 78, 71, 0, 77]);
    await call(principal, "artifact.import", { filename: "diagram.png", base64: png.toString("base64") });
    const project = path.join(r, "approved-project");
    fs.mkdirSync(project);
    const input = {
      sessionId: "auto_session", filePath: "artifacts/diagram.png",
      destinationPath: "docs/diagram.png",
    };
    const prepared = publish(principal, project, "prepare", input);
    expect(prepared.preview.sha256).toBe(crypto.createHash("sha256").update(png).digest("hex"));
    expect(publish("oauth:other", project, "confirm", { sessionId: "auto_session", challenge: prepared.challenge }).error).toBeTruthy();
    const done = publish(principal, project, "confirm", { sessionId: "auto_session", challenge: prepared.challenge });
    expect(done.success).toBe(true);
    expect(fs.readFileSync(path.join(project, "docs", "diagram.png"))).toEqual(png);
    expect(publish(principal, project, "confirm", { sessionId: "auto_session", challenge: prepared.challenge }).error).toBeTruthy();
    expect(publish(principal, project, "prepare", input).error).toMatch(/exists/i);
    expect(publish(principal, project, "prepare", { ...input, destinationPath: "../leak.png" }).error).toBeTruthy();
    expect(publish(principal, project, "", input).error).toMatch(/requires action/i);
  });

  it("stops publishing if its source file changes between prepare and confirm", async () => {
    root();
    const principal = "oauth:owner";
    const session = createBrainSession(principal, "my-session");
    fs.writeFileSync(path.join(session.artifactsPath, "report.txt"), "old");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "brain-publish-target-"));
    roots.push(target);
    const args = { sessionId: "my-session", filePath: "artifacts/report.txt", destinationPath: "reports/report.txt" };
    const preview = publish(principal, target, "prepare", args);
    expect(preview.preview).toBeTruthy();
    fs.writeFileSync(path.join(session.artifactsPath, "report.txt"), "new");
    expect(publish(principal, target, "confirm", { sessionId: "my-session", challenge: preview.challenge }).error).toMatch(/changed/i);
    expect(fs.existsSync(path.join(target, "reports", "report.txt"))).toBe(false);
  });
});
