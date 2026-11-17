import { describe, expect, it } from "vitest";
import fs from "node:fs";

const exchange = fs.readFileSync(
  "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/LanFileExchange.java", "utf8",
);
const server = fs.readFileSync(
  "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/LanClientServer.java", "utf8",
);
const html = fs.readFileSync("apps/superagent-tray/ui/index.html", "utf8");
const transfer = fs.readFileSync("apps/superagent-tray/ui/lan-file-transfer.js", "utf8");

describe("LAN cancellation cannot silently publish Android files", () => {
  it("revokes pending writes before waiting for the Java monitor", () => {
    expect(exchange).toContain("private volatile Pending active;");
    expect(exchange).toMatch(/public JSONObject abort\(String id\)/);
    const abort = exchange.slice(exchange.indexOf("public JSONObject abort(String id)"));
    expect(abort.indexOf("revocationGeneration.incrementAndGet()")).toBeGreaterThan(0);
    expect(abort.indexOf("synchronized (this)")).toBeGreaterThan(abort.indexOf("revocationGeneration.incrementAndGet()"));
    expect(exchange).toContain("if (revocationGeneration.get() != expectedGeneration)");
    expect(exchange).toContain("context.getContentResolver().delete(uri, null, null)");
    expect(exchange).toContain("LanFolderPackage.extract(context, bytes)");
  });
  it("keeps abort under a validated paired session, not a public unauthenticated endpoint", () => {
    expect(server).toContain('"file_abort".equals(op)');
    expect(server).toContain("isStillAuthorized(active, owner, ip)");
    expect(server).toContain("fileExchange.abort(transferId)");
  });
  it("presents clear pause/resume/cancel and volatile receipts in the desktop UI", () => {
    expect(html).toContain('id="lan-file-pause"');
    expect(html).toContain('id="lan-file-cancel"');
    expect(html).toContain('id="lan-file-history"');
    expect(transfer).toContain("async function waitIfPaused()");
    expect(transfer).toContain("const recent = [];");
    expect(transfer).toContain("const resolve = resumeWake;");
    expect(transfer).toContain("wake();");
    expect(transfer).not.toContain("localStorage");
    expect(transfer).not.toContain("sessionStorage");
  });
});
