import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { recordBrainEvent, summarizeBrainEvents } from "../src/core/brain/brainObservability.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir,{recursive:true,force:true}); });
describe("Brain observability permissions and redaction", () => {
  it("stores only allowlisted operations and never stores caller data or tokens", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-telemetry-")); dirs.push(root);
    const privateId = "oauth:user_a-secret-token";
    recordBrainEvent(privateId, "transfer.begin", "ok", 15.5, root);
    recordBrainEvent(privateId, "transfer.finish", "error", 34, root);
    recordBrainEvent(privateId, "file:///C:/Users/PRIVATE/token.txt", "error", 5, root);
    const report = summarizeBrainEvents(privateId, root);
    expect(report.events).toBe(2);
    expect(report.failures).toBe(1);
    expect(report.types.find(item=>item.event==="transfer.begin")?.avgDurationMs).toBe(16);
    expect(summarizeBrainEvents("oauth:someone_else", root).events).toBe(0);
    const namespace = crypto.createHash("sha256").update(privateId).digest("hex").slice(0,24);
    const file = path.join(root,"brain-telemetry",namespace,"events.jsonl");
    const raw = fs.readFileSync(file,"utf8");
    expect(raw).not.toContain("PRIVATE");
    expect(raw).not.toContain("secret-token");
    expect(raw).not.toContain("file://");
    expect(raw).not.toContain("oauth:user_a");
  });
  it("handles corrupt records without leaking and ignores outdated events", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-telemetry-")); dirs.push(root);
    const principal = "local-cli";
    recordBrainEvent(principal, "cleanup.confirm", "ok", 7, root);
    const namespace = crypto.createHash("sha256").update(principal).digest("hex").slice(0,24);
    const file = path.join(root,"brain-telemetry",namespace,"events.jsonl");
    fs.appendFileSync(file,"{not-json}\n");
    fs.appendFileSync(file, JSON.stringify({at:"1999-01-01T00:00:00Z",event:"transfer.finish",outcome:"ok",durationMs:1})+"\n");
    expect(summarizeBrainEvents(principal,root).events).toBe(1);
  });
});
