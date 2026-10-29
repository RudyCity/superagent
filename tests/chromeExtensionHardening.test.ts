import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { TextDecoder, TextEncoder } from "node:util";

const file = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

describe("Chrome extension/backend security regressions", () => {
  it("streams SSE through authenticated fetch without putting credentials in the URL", async () => {
    const script = file("chrome-extension/sidepanel-sse.js");
    let requestedUrl = "";
    let headers: Record<string, string> = {};
    const frame = new TextEncoder().encode('data: {"type":"ping"}\n\n');
    const build = runInNewContext(script + "\ncreateAuthorizedEventStream", {
      fetch: async (url: string, options: { headers: Record<string, string> }) => {
        requestedUrl = url;
        headers = options.headers;
        return {
          ok: true,
          body: { getReader: () => ({ read: async () => ({ done: false, value: frame }) }) },
        };
      },
      Promise,
      URL,
      AbortController,
      TextDecoder,
      setTimeout,
      clearTimeout,
      Error,
    }) as (url: string) => { onmessage: ((event: { data: string }) => void) | null; close: () => void };

    const stream = build("http://localhost:7888/api/events?source=sidepanel");
    const received = new Promise<string>((resolve) => {
      stream.onmessage = (event) => {
        stream.close();
        resolve(event.data);
      };
    });
    await expect(received).resolves.toBe('{"type":"ping"}');
    expect(requestedUrl).not.toContain("token=");
    expect(headers.Accept).toBe("text/event-stream");
    const sidepanel = file("chrome-extension/sidepanel.js");
    expect(sidepanel).not.toContain('params.set("token", apiToken)');
    expect(sidepanel).toContain("createAuthorizedEventStream(sseUrl)");
    expect(sidepanel).toContain("targetUrl.origin !== new URL(BASE_URL).origin");
  });

  it("logs only sanitized route metadata and routes browser controls without broadcast", () => {
    const backend = file("src/server.ts");
    expect(backend).toContain("crypto.randomBytes(32).toString");
    expect(backend).toContain('Browser control needs exactly one connected extension');
    expect(backend).not.toContain("broadcastEvent(event);\n    }\n  });");
    expect(backend).not.toContain('logToSuperAgentServerFile(`[Request] ${req.method} ${req.url}');
    expect(backend).toContain('workspaceHeader=');
    const routes = file("src/serverRoutes.ts");
    expect(routes).toContain("crypto.timingSafeEqual(submitted, expected)");
    expect(routes).toContain("browserInstances.get(instanceKey)?.res === res");
  });

  it("preserves bridge credentials only in session storage and rejects unsupported actions", () => {
    const worker = file("chrome-extension-remote/background.js");
    expect(worker).toContain('chrome.storage.session.get("bridgeToken")');
    expect(worker).toContain("Unknown Remote Bridge action");
    expect(worker).toContain("getBridgeClientId");
    expect(worker).toContain('remoteMonitoringEnabled !== true');
    const bridge = file("src/core/tools/remoteChromeBridge.ts");
    expect(bridge).toContain("pairedExtensionOrigin");
    expect(bridge).toContain("Ambiguous Remote Chrome clients");
    expect(bridge).toContain("maxPayload: 16 * 1024 * 1024");
  });

  it("does not enable wildcard CDP origins or unattended screen capture by default", () => {
    const common = file("src/core/tools/chromeCommon.ts");
    const launcher = file("src/core/tools/chromeBrowserTools.ts");
    const flags = file("src/core/browserRuntime/browserFlags.ts");
    expect(common).not.toContain("--remote-allow-origins=*");
    expect(launcher).not.toContain("--remote-allow-origins=*");
    expect(common).toContain('SUPERAGENT_UNATTENDED_SCREEN_CAPTURE === "1"');
    expect(flags).toContain("if (useFakeMediaUi)");
    expect(flags).toContain("--use-fake-ui-for-media-stream");
  });

  it("syntax gate enumerates both unpacked extensions", () => {
    const gate = file("scripts/verify-extension-js.mjs");
    expect(gate).toContain('["chrome-extension", "chrome-extension-remote"]');
    expect(gate).toContain('readdir(directory)');
  });
});
