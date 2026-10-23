import { describe, expect, it } from "vitest";
import { inferSenopatiV2Approval, inferSenopatiV2Risk, guardSenopatiV2Shadow } from "../src/core/senopatiV2Safety.js";
import type { SenopatiV2ShadowPrediction } from "../src/core/senopatiV2Shadow.js";

describe("Senopati V2 shadow never grants execution consent", () => {
  it.each([
    ["saya setuju", "affirm"],
    ["yes, approve", "affirm"],
    ["tidak setuju", "deny"],
    ["saya menolak rencana yang diajukan", "deny"],
    ["not approved", "deny"],
    ["jangan lanjut", "deny"],
    ["approve after the deployment window", "conditional"],
    ["sure, but not now", "conditional"],
    ["oke tapi jangan edit", "conditional"],
    ["setuju kalau hanya audit", "conditional"],
    ["mungkin saja", "none"],
  ])("pending context, %s -> %s", (text, expected) => {
    expect(inferSenopatiV2Approval(text, "PLANNING_PENDING")).toBe(expected);
  });

  it.each(["iya", "yes", "oke", "lanjut", "approve", "go ahead"])("never approves %s outside planning", (text) => {
    expect(inferSenopatiV2Approval(text, "IDLE")).toBe("none");
  });

  it.each([
    ["Jalankan rm -rf ~/Documents.", "destructive"],
    ["Run docker system prune -a --volumes.", "destructive"],
    ["Execute git clean -fdx.", "destructive"],
    ["git reset --hard HEAD", "destructive"],
    ["DROP TABLE payments", "destructive"],
    ["Apa efek git reset --hard?", "safe"],
    ["Explain consequences of rm -rf", "safe"],
    ["Kirim dokumen paspor pribadi", "sensitive"],
    ["Transfer dana ke rekening baru", "sensitive"],
  ])("guards %s as %s", (text, expected) => {
    expect(inferSenopatiV2Risk(text)).toBe(expected);
  });

  it("never converts the advisory label into execution authority", () => {
    const raw: SenopatiV2ShadowPrediction = {
      source: "senopati-v2-sparse-shadow",
      labels: { domain: "engineering", intent: "execute", action: "tools", risk: "safe", approval: "affirm" },
      relativeScores: { domain: 0.8, intent: 0.7, action: 0.7, risk: 0.5, approval: 0.5 },
      authorizesExecution: false,
    };
    const result = guardSenopatiV2Shadow(raw, "approve after legal review", "PLANNING_PENDING");
    expect(result.labels.approval).toBe("conditional");
    expect(result.authorizesExecution).toBe(false);
    expect(raw.labels.approval).toBe("affirm");
  });
});
