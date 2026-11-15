import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { startDeviceQrRequest, pollDeviceQrRequest, normalizeDeviceQrOrigin } from "../src/core/deviceTunnel/displayQrClient.js";
import { LAN_MCP_TOOL_CLASSIFICATIONS, LAN_MCP_TOOL_DEFS } from "../src/core/mcp/tools/lanMcpTools.js";

afterEach(() => { vi.unstubAllGlobals(); });

const id = "11111111-2222-4333-8444-555555555555";
const requestToken = "b".repeat(64);

function mockJson(json: unknown) {
  return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("Cross-device display QR bootstrap", () => {
  it("accepts only a trusted, clean HTTPS origin", () => {
    expect(normalizeDeviceQrOrigin("https://core.example")).toBe("https://core.example");
    for (const text of [
      "http://core.example", "https://user:password@core.example",
      "https://core.example/path", "https://core.example/?secret=1",
      "https://core.example:8080", "https://core.example/#fragment", "file:///etc/passwd",
    ]) expect(() => normalizeDeviceQrOrigin(text)).toThrow();
  });

  it("publishes only public QR fields while storing the poll token in receiver memory", async () => {
    let requestBody: any;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://core.example/api/device-tunnel/tv/request");
      expect(init.redirect).toBe("error");
      requestBody = JSON.parse(String(init.body));
      return mockJson({ success: true, request: {
        id, pollToken: requestToken, expiresAt: Date.now() + 180_000,
      } });
    }));
    const { ticket, publicPayload, qrDataUrl } = await startDeviceQrRequest("https://core.example", "Windows laptop");
    expect(requestBody.challenge).toMatch(/^[a-f0-9]{64}$/);
    expect(requestBody.name).toBe("Windows laptop");
    expect(publicPayload).toContain('"k":"satv"');
    expect(publicPayload).toContain(ticket.challenge);
    expect(publicPayload).not.toContain(requestToken);
    expect(publicPayload).not.toContain("pollToken");
    expect(qrDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(ticket.pollToken).toBe(requestToken);
    const windowsEngine = fs.readFileSync("src/lanClientGui.ts", "utf8");
    const displayed = windowsEngine.match(/emit\("device_qr_ready",\s*\{[^}]+\}/)?.[0] || "";
    expect(displayed).toContain("qrDataUrl");
    expect(displayed).toContain("ticket.challenge");
    expect(displayed).not.toContain("pollToken");
    expect(displayed).not.toContain("ticket.pollToken");
  });

  it("uses private credential to poll and validates the one-time enrollment", async () => {
    const expiresAt = Date.now() + 150_000;
    const ticket = {
      origin: "https://core.example", id, pollToken: requestToken,
      challenge: "a".repeat(64), expiresAt,
    };
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://core.example/api/device-tunnel/tv/poll");
      expect(JSON.parse(String(init.body))).toEqual({ id, pollToken: requestToken });
      calls++;
      if (calls === 1) return mockJson({ success: true, result: { state: "pending" } });
      return mockJson({ success: true, result: {
        state: "approved", inviteId: "11111111-2222-4333-8444-555555555555",
        code: "0123456789", expiresAt: Date.now() + 300_000,
      } });
    }));
    expect(await pollDeviceQrRequest(ticket)).toEqual({ state: "pending" });
    const result = await pollDeviceQrRequest(ticket);
    expect(result).toEqual({ state: "approved", enrollment: {
      url: "https://core.example", inviteId: id, code: "0123456789",
    } });
    expect(calls).toBe(2);
  });

  it("rejects oversized responses and malformed enrollment without granting access", async () => {
    const ticket = {
      origin: "https://core.example", id, pollToken: requestToken,
      challenge: "a".repeat(64), expiresAt: Date.now() + 180_000,
    };
    vi.stubGlobal("fetch", vi.fn(async () => mockJson({ success: true, result: {
      state: "approved", inviteId: id, code: "insecure", expiresAt: Date.now() + 300_000,
    } })));
    await expect(pollDeviceQrRequest(ticket)).rejects.toThrow(/Invalid or expired/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(5000), { status: 200 })));
    await expect(pollDeviceQrRequest(ticket)).rejects.toThrow(/too large/);
  });

  it("registers a dangerous generic MCP approval tool while retaining TV compatibility", () => {
    for (const name of ["superagent_device_tunnel_qr_approve", "superagent_device_tunnel_tv_approve"]) {
      expect(LAN_MCP_TOOL_CLASSIFICATIONS[name]).toBe("dangerous");
      const def = LAN_MCP_TOOL_DEFS.find(tool => tool.name === name);
      expect(def).toBeDefined();
      expect(def?.inputSchema.required).toEqual(["requestId", "challenge"]);
      expect(def?.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("Windows UI requires owner confirmation and does not render a private poll token", () => {
    const html = fs.readFileSync("apps/superagent-lan-windows/ui/index.html", "utf8");
    const js = fs.readFileSync("apps/superagent-lan-windows/ui/app.js", "utf8");
    const engine = fs.readFileSync("src/lanClientGui.ts", "utf8");
    const native = fs.readFileSync("apps/superagent-lan-windows/src-tauri/src/main.rs", "utf8");
    for (const id of ["display-qr-origin", "display-qr-start", "display-qr-cancel",
      "display-qr-image", "display-qr-accept", "display-qr-deny"]) expect(html).toContain('id="' + id + '"');
    expect(js).toContain('invokeAction("accept_qr")');
    expect(native).toContain('"accept_qr"');
    expect(engine).toContain('pendingDeviceEnrollment');
    expect(engine).toContain('if (!pendingDeviceEnrollment || !pendingQrOrigin)');
    expect(js).not.toContain("pollToken");
    expect(html).not.toContain("pollToken");
    expect(engine).toContain('qrController?.abort()');
  });
});
