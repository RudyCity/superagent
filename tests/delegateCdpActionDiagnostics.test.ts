import { describe, expect, it } from "vitest";
import {
  classifyDelegateActionError, delegateActionOutcome, recordDelegateAction,
  readDelegateActionDiagnostics, retryPolicyForDelegateAction,
} from "../src/core/browserTransport/delegateActionDiagnostics.js";

describe("Delegate-CDP action diagnostics", () => {
  it("classifies structural codes without reading sensitive freeform messages", () => {
    expect(classifyDelegateActionError({ code: "DELEGATE_CDP_STALE_REVISION", message: "password=hidden" })).toBe("LEASE_CONFLICT");
    expect(classifyDelegateActionError({ code: "DELEGATE_CDP_NOT_CONNECTED" })).toBe("DISCONNECTED");
    expect(classifyDelegateActionError({ code: "DELEGATE_CDP_PERMISSION_DENIED" })).toBe("PERMISSION_DENIED");
    expect(classifyDelegateActionError({ code: "DELEGATE_TIMEOUT" })).toBe("TIMEOUT");
    expect(classifyDelegateActionError(new Error("This tool call was blocked by OpenAI's safety checks"))).toBe("EXECUTION_FAILED");
  });

  it("treats dispatched click as executed, never as verified publication", () => {
    expect(delegateActionOutcome("click", 'control_chrome_cdp: Delegate click: {"ok":true}'))
      .toMatchObject({ outcome: "executed", retryPolicy: "manual_reconcile" });
    expect(delegateActionOutcome("navigate", '{"status":"navigated"}'))
      .toMatchObject({ outcome: "executed", retryPolicy: "manual_reconcile" });
  });

  it("does not auto-replay uncertain side effects but permits read-only retry", () => {
    expect(delegateActionOutcome("click", undefined, { code: "DELEGATE_TIMEOUT" }))
      .toMatchObject({ outcome: "unknown", category: "TIMEOUT", retryPolicy: "manual_reconcile" });
    expect(retryPolicyForDelegateAction("type", "unknown")).toBe("manual_reconcile");
    expect(retryPolicyForDelegateAction("evaluate", "unknown")).toBe("manual_reconcile");
    expect(retryPolicyForDelegateAction("snapshot", "failed")).toBe("safe_read_only");
  });

  it("records bounded metadata without raw session tokens, URLs, content, or error messages", () => {
    const secret = "sensitive-session-token-123";
    const entry = recordDelegateAction({
      command: "click", clientId: "client-001", tabId: 11, startedAt: Date.now(),
      error: { code: "DELEGATE_TIMEOUT", message: secret, url: "https://secret.example" },
    });
    const json = JSON.stringify(entry);
    expect(json).not.toContain(secret);
    expect(json).not.toContain("client-001");
    expect(json).not.toContain("secret.example");
    expect(entry.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.clientFingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(readDelegateActionDiagnostics(1)[0].operationId).toBe(entry.operationId);
  });

  it("marks missing click target failed, not successful", () => {
    expect(delegateActionOutcome("click", 'control_chrome_cdp: Delegate click: {"ok":false,"reason":"not_found"}'))
      .toMatchObject({ outcome: "failed", retryPolicy: "never" });
    expect(delegateActionOutcome("type", "control_chrome_cdp failed: DELEGATE_CDP_TOKEN_CONFLICT: invalid"))
      .toMatchObject({ outcome: "failed", category: "INPUT_INVALID" });
  });
});
