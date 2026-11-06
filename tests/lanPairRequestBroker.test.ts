import { afterEach, describe, expect, it } from "vitest";
import {
  cancelLanPairRequest,
  createLanPairRequest,
  getLanPairRequest,
  listLanPairRequests,
  resetLanPairRequestsForTests,
} from "../src/core/lanRemote/pairRequestBroker.js";
import { lanInterfaces } from "../src/core/lanRemote/transport.js";
import { parseTrayLanAction } from "../src/core/runtime/trayLanBridge.js";

describe("LAN pairing request broker", () => {
  afterEach(() => resetLanPairRequestsForTests());

  const adapter = lanInterfaces()[0];
  const maybeIt = adapter ? it : it.skip;

  maybeIt("stores no pairing code and exposes only opaque request state", () => {
    const request = createLanPairRequest({
      host: adapter.address,
      port: 17845,
      fingerprint: "a".repeat(64),
      controller: "SuperAgent MCP",
      segment: "testing",
    });
    expect(request.requestId).toMatch(/^[a-f0-9-]{36}$/i);
    expect(request.state).toBe("pending");
    expect(request).not.toHaveProperty("code");
    expect(JSON.stringify(request)).not.toContain("12345678");
    expect(listLanPairRequests()).toHaveLength(1);
    expect(getLanPairRequest(request.requestId).fingerprint).toBe("a".repeat(64));
  });

  maybeIt("allows a pending request to be cancelled without opening access", () => {
    const request = createLanPairRequest({
      host: adapter.address,
      fingerprint: "b".repeat(64),
    });
    const cancelled = cancelLanPairRequest(request.requestId);
    expect(cancelled.state).toBe("cancelled");
    expect(() => cancelLanPairRequest(request.requestId)).toThrow(/pending/i);
  });
});

describe("Tray LAN secretless pairing contract", () => {
  it("accepts MCP request creation without a code", () => {
    const parsed = parseTrayLanAction({
      action: "pair_request",
      host: "10.20.30.40",
      port: 17845,
      fingerprint: "c".repeat(64),
      controller: "SuperAgent MCP",
      segment: "testing",
    });
    expect(parsed.action).toBe("pair_request");
    expect(parsed.args).not.toHaveProperty("code");
  });

  it("requires the code only for local pair completion", () => {
    const requestId = "11111111-2222-3333-4444-555555555555";
    expect(() => parseTrayLanAction({
      action: "pair_complete", requestId, code: "12345678", verified: false,
    })).toThrow(/confirmation/i);
    expect(parseTrayLanAction({
      action: "pair_complete", requestId, code: "12345678", verified: true,
    }).action).toBe("pair_complete");
  });
});
