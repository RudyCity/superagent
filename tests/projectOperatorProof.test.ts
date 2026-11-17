import { describe, expect, it } from "vitest";
import { ProjectOperatorProof } from "../src/core/project/projectOperatorProof.js";

describe("Project operator proof", () => {
  const key = Buffer.alloc(32, 0x42);
  const payloadText = JSON.stringify({
    action: "register", id: "fixture", name: "Fixture",
    type: "ssh", target: "ssh://deploy@host/srv/app",
  });
  it("accepts exact signed payload once and burns replay", () => {
    let now = 1000;
    const guard = new ProjectOperatorProof(() => key, () => now);
    const { nonce } = guard.issue();
    const proof = { nonce, mac: ProjectOperatorProof.signForTest(key, nonce, payloadText) };
    expect(guard.consume({ payloadText, proof })).toMatchObject({ action: "register", id: "fixture" });
    expect(() => guard.consume({ payloadText, proof })).toThrow("PROJECT_OPERATOR_PROOF_REQUIRED");
  });
  it("rejects altered payload, burns forged attempt and rejects expiry", () => {
    let now = 1000;
    const guard = new ProjectOperatorProof(() => key, () => now);
    const { nonce } = guard.issue();
    const proof = { nonce, mac: ProjectOperatorProof.signForTest(key, nonce, payloadText) };
    expect(() => guard.consume({ payloadText: payloadText + " ", proof }))
      .toThrow("PROJECT_OPERATOR_PROOF_REQUIRED");
    expect(() => guard.consume({ payloadText, proof })).toThrow("PROJECT_OPERATOR_PROOF_REQUIRED");
    const second = guard.issue();
    now += 30_001;
    expect(() => guard.consume({
      payloadText, proof: {
        nonce: second.nonce, mac: ProjectOperatorProof.signForTest(key, second.nonce, payloadText),
      },
    })).toThrow("PROJECT_OPERATOR_PROOF_REQUIRED");
  });
  it("rejects injected attributes, malformed signatures and non-object payloads", () => {
    const guard = new ProjectOperatorProof(() => key);
    const { nonce } = guard.issue();
    const proof = { nonce, mac: ProjectOperatorProof.signForTest(key, nonce, payloadText) };
    expect(() => guard.consume({ payloadText, proof, capabilities: ["write"] }))
      .toThrow("PROJECT_OPERATOR_PROOF_REQUIRED");
    expect(() => guard.consume({ payloadText, proof: { nonce, mac: "0".repeat(64) } }))
      .toThrow("PROJECT_OPERATOR_PROOF_REQUIRED");
    expect(() => guard.consume({ payloadText, proof }))
      .toThrow("PROJECT_OPERATOR_PROOF_REQUIRED");
    expect(() => guard.consume(null)).toThrow("PROJECT_OPERATOR_PROOF_REQUIRED");
  });
});
