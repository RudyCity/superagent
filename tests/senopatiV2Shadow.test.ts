import { describe, expect, it } from "vitest";
import { SenopatiV2Shadow, SENOPATI_V2_HEADS, extractSenopatiV2SparseFeatures } from "../src/core/senopatiV2Shadow.js";

function payload() {
  return {
    format: "senopati-v2-sparse-baseline" as const,
    deployment: "candidate-only" as const,
    heads: Object.fromEntries(Object.entries(SENOPATI_V2_HEADS).map(([key, labels]) => [key, [...labels]])) as any,
    records: [
      { domain: "writing", intent: "draft", action: "answer", risk: "safe", approval: "none",
        features: extractSenopatiV2SparseFeatures("message tulis email sopan") },
      { domain: "engineering", intent: "execute", action: "tools", risk: "destructive", approval: "none",
        features: extractSenopatiV2SparseFeatures("message git reset --hard") },
      { domain: "conversation", intent: "approve", action: "none", risk: "safe", approval: "affirm",
        features: extractSenopatiV2SparseFeatures("context PLANNING_PENDING message saya setuju") },
    ],
  };
}

describe("Senopati V2 shadow (never authorizes tools)", () => {
  it("matches sparse feature prefix, word and trigram weights", () => {
    const v = extractSenopatiV2SparseFeatures("message halo rumah");
    expect(v["w:message"]).toBe(3);
    expect(v["w:halo"]).toBe(3);
    expect(v["b:message_halo"]).toBe(1.8);
    expect(v["c:hal"]).toBe(0.45);
  });
  it("predicts every named head without granting authorization", () => {
    const model = new SenopatiV2Shadow(payload());
    const reply = model.predict("tulis email sopan");
    expect(reply.labels).toMatchObject({ domain: "writing", intent: "draft", action: "answer" });
    expect(reply.authorizesExecution).toBe(false);
    expect(reply.source).toBe("senopati-v2-sparse-shadow");
    expect(reply.relativeScores.domain).toBeGreaterThan(0);
  });
  it("uses conversation status solely for labeling, not permission", () => {
    const model = new SenopatiV2Shadow(payload());
    const result = model.predict("saya setuju", "PLANNING_PENDING");
    expect(result.labels.approval).toBe("affirm");
    expect(result.authorizesExecution).toBe(false);
  });
  it("rejects schema mismatch or released model masquerading as a candidate", () => {
    const data = payload();
    expect(() => new SenopatiV2Shadow({ ...data, deployment: "production" as any })).toThrow();
    expect(() => new SenopatiV2Shadow({ ...data, heads: { ...data.heads, risk: ["destructive", "safe", "sensitive"] } })).toThrow(/label order/);
  });
  it("rejects malicious vectors and unknown labels", () => {
    const data = payload();
    data.records[0].features["w:evil"] = Number.POSITIVE_INFINITY;
    expect(() => new SenopatiV2Shadow(data)).toThrow(/weight/);
    const other = payload();
    (other.records[0] as any).domain = "unknown";
    expect(() => new SenopatiV2Shadow(other)).toThrow(/training label/);
  });
});
