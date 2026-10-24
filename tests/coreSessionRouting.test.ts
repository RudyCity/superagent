import { describe, expect, it } from "vitest";
import { CoreSessionAffinity, inspectCoreSessionRequest, CORE_ROUTING_BODY_LIMIT } from "../src/core/runtime/coreSessionRouting.js";

const oldWorker = { pid: 101, port: 15001, since: 1000 };
const newWorker = { pid: 102, port: 15002, since: 2000 };

describe("core worker session affinity", () => {
  it("extracts validated query, header, resume, and body session IDs", () => {
    expect(inspectCoreSessionRequest("/api/events?sessionId=s123", "GET", {}).sessionId).toBe("s123");
    expect(inspectCoreSessionRequest("/api/chat", "POST", {}, '{"sessionId":"s123","message":"hello"}').sessionId).toBe("s123");
    expect(inspectCoreSessionRequest("/api/init", "POST", {}, '{"resume":"s123"}').sessionId).toBe("s123");
    expect(inspectCoreSessionRequest("/api/switch-workspace", "POST", {}, '{"id":"s123"}').sessionId).toBe("s123");
    expect(inspectCoreSessionRequest("/api/history?id=s123", "GET", {}).sessionId).toBe("s123");
    expect(inspectCoreSessionRequest("/api/status", "GET", {"x-superagent-session-id":"s123"}).sessionId).toBe("s123");
    expect(inspectCoreSessionRequest("/api/events?sessionId=%0Ax", "GET", {}).sessionId).toBeUndefined();
    expect(inspectCoreSessionRequest("/api/chat", "POST", {}, "not json").sessionId).toBeUndefined();
    expect(CORE_ROUTING_BODY_LIMIT).toBe(1024 * 1024);
  });

  it("pins previously initialized sessions and assigns new ones to the newest worker", () => {
    const affinity = new CoreSessionAffinity();
    expect(affinity.registerFromResponse(200, '{"success":true,"sessionId":"s123"}', oldWorker)).toBe("s123");
    expect(affinity.resolve("s123", newWorker)).toEqual(oldWorker);
    expect(affinity.resolve("sNEW", newWorker)).toEqual(newWorker);
    expect(affinity.count).toBe(1);
    expect(affinity.countForOwner(oldWorker)).toBe(1);
    expect(affinity.countForOwner(newWorker)).toBe(0);
  });

  it("never captures rejected, mismatched or collision session responses", () => {
    const affinity = new CoreSessionAffinity();
    expect(affinity.registerFromResponse(401, '{"success":true,"sessionId":"bad"}', oldWorker)).toBeUndefined();
    expect(affinity.registerFromResponse(200, '{"success":false,"sessionId":"bad"}', oldWorker)).toBeUndefined();
    expect(affinity.registerFromResponse(200, '{"success":true,"sessionId":"bad"}', oldWorker, "expected")).toBeUndefined();
    affinity.registerFromResponse(200, '{"success":true,"sessionId":"s123"}', oldWorker);
    expect(affinity.registerFromResponse(200, '{"success":true,"sessionId":"s123"}', newWorker)).toBeUndefined();
    expect(affinity.resolve("s123", newWorker)).toEqual(oldWorker);
    expect(affinity.count).toBe(1);
  });
});
