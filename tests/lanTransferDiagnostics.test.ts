import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("apps/superagent-tray/ui/lan-transfer-diagnostics.js", "utf8");
const transfer = fs.readFileSync("apps/superagent-tray/ui/lan-file-transfer.js", "utf8");
const html = fs.readFileSync("apps/superagent-tray/ui/index.html", "utf8");

function harness() {
  const display = { textContent: "" };
  const window: any = {};
  vm.runInNewContext(source, {
    window, document: { readyState: "complete",
      getElementById: (id: string) => id === "lan-file-diagnostics" ? display : null },
    Set, Math, Number, Array, String, Date, Error,
  });
  return { api: window.LanTransferDiagnostics, display };
}

describe("LAN P2 telemetry is bounded and credential-free", () => {
  it("renders transfer throughput, p95 chunk latency, recovered responses and outcome", () => {
    const h = harness();
    h.api.start("upload", "lan", "v2", 65536);
    h.api.sample(16384, 11);
    h.api.sample(32768, 40, true);
    h.api.sample(65536, 80);
    expect(h.display.textContent).toContain("p95 80 ms");
    expect(h.display.textContent).toContain("1 recovered response(s)");
    expect(h.display.textContent).toContain("v2");
    h.api.finish("verified");
    expect(h.display.textContent).toContain("verified");
    expect(h.display.textContent).toContain("65536/65536");
  });

  it("classifies failures without rendering raw exception text or secrets", () => {
    const h = harness();
    h.api.start("download", "tunnel", "v1", 10);
    h.api.sample(4, 12);
    h.api.failure("connection lost: session token=SECRET_PRIVACY_VALUE");
    expect(h.display.textContent).toContain("network");
    expect(h.display.textContent).toContain("not verified");
    expect(h.display.textContent).not.toContain("SECRET_PRIVACY_VALUE");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
  });

  it("rejects impossible or backwards progress", () => {
    const h = harness();
    expect(() => h.api.start("upload", "internet", "v2", 100)).toThrow();
    h.api.start("upload", "lan", "v2", 100);
    h.api.sample(50, 20);
    expect(() => h.api.sample(49, 20)).toThrow();
    expect(() => h.api.sample(101, 20)).toThrow();
    expect(() => h.api.sample(51, -20)).toThrow();
    h.api.finish("cancelled");
  });

  it("is wired into all upload/download loops and the collapsible UI", () => {
    expect(html).toContain('src="./lan-transfer-diagnostics.js"');
    expect(html).toContain('id="lan-file-diagnostics"');
    expect(transfer).toContain('diagnosticsStart(device, "v1", bytes.length, "upload")');
    expect(transfer).toContain('diagnosticsStart(device, "v2", file.size, "upload")');
    expect(transfer).toContain('diagnosticsStart(device, "v1", offer.size, "download")');
    expect(transfer).toContain('window.LanTransferDiagnostics?.failure(error)');
  });
});
