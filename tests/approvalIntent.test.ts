import { describe, expect, it } from "vitest";
import { isExplicitPlanApproval, isExactContinuation } from "../src/core/agent/ApprovalIntent.js";

describe("pending plan approval intent", () => {
  it.each(["tidak setuju", "jangan perbaiki", "oke jangan jalankan", "aku tidak mau lanjut", "jangan ganti mode", "lanjut tetapi hanya audit", "setuju kalau nanti", "no, go ahead", "belum setuju", "tidak perlu implementasi", "boleh tapi jangan edit", "ok tanpa perubahan"])("rejects denial/conditional input: %s", (value) => {
    expect(isExplicitPlanApproval(value)).toBe(false);
  });

  it.each(["oke", "iya", "setuju", "saya setuju", "lanjut", "silakan lanjut", "approve", "lgtm", "gas", "yes", "lanjut implementasi"])("accepts an explicit standalone affirmative: %s", (value) => {
    expect(isExplicitPlanApproval(value)).toBe(true);
  });

  it("does not treat an arbitrary sentence as continuation or consent", () => {
    expect(isExactContinuation("oke, jangan jalankan")).toBe(false);
    expect(isExactContinuation("lanjut riset saja tanpa implementasi")).toBe(false);
    expect(isExactContinuation("terima kasih")).toBe(false);
    expect(isExactContinuation("continue")).toBe(true);
  });
});
