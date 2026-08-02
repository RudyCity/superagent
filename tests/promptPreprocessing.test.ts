import { describe, it, expect } from "vitest";
import { maskSensitiveData, unmaskSensitiveData, clearSecretVault, trimConversationalNoise, translationBadgeEmitter } from "../src/core/promptClarification.js";

describe("Secret Data Masking & Alias Vault (Security Pre-Filter)", () => {
  it("should redact OpenAI API keys using secret aliases ($SECRET_N)", () => {
    clearSecretVault();
    const raw = "tolong cek api key ini sk-proj-123456789012345678901234567890 di file env";
    const { maskedText, secretsFound, vault } = maskSensitiveData(raw);
    expect(secretsFound).toBe(true);
    expect(maskedText).not.toContain("sk-proj-123456789012345678901234567890");
    expect(maskedText).toMatch(/\$SECRET_\d+/);
    
    // Test unmasking
    const restored = unmaskSensitiveData(maskedText);
    expect(restored).toBe(raw);
  });

  it("should redact GitHub personal access tokens with alias", () => {
    clearSecretVault();
    const raw = "token ghp_123456789012345678901234567890123456 ganti ya";
    const { maskedText, secretsFound } = maskSensitiveData(raw);
    expect(secretsFound).toBe(true);
    expect(maskedText).toMatch(/\$SECRET_\d+/);
  });

  it("should redact password key-value patterns with secret alias", () => {
    clearSecretVault();
    const raw = "db_pass=Admin@123!#$";
    const { maskedText, secretsFound } = maskSensitiveData(raw);
    expect(secretsFound).toBe(true);
    expect(maskedText).toContain("db_pass= $SECRET_");

    // Verify unmasking back to original password
    expect(unmaskSensitiveData(maskedText)).toBe("db_pass= Admin@123!#$");
  });

  it("should clear secret vault cleanly when requested", () => {
    clearSecretVault();
    maskSensitiveData("db_pass=Pass1234!");
    clearSecretVault();
    expect(unmaskSensitiveData("$SECRET_1")).toBe("$SECRET_1");
  });

  it("should emit security badge event when secret is detected", async () => {
    let eventReceived = false;
    const handler = (badge: any) => {
      if (badge.securityRedacted) {
        eventReceived = true;
      }
    };
    translationBadgeEmitter.once("badge", handler);
    maskSensitiveData("api_key: SecretKeyWith#SpecialChar!123");
    expect(eventReceived).toBe(true);
  });
});

describe("Noise & Filler Trimming (Token Saver)", () => {
  it("should trim Indonesian conversational fillers", () => {
    const raw = "halo mas ai tolong bantu saya untuk perbaiki fungsi ini dong";
    const cleaned = trimConversationalNoise(raw);
    expect(cleaned).toBe("perbaiki fungsi ini");
  });

  it("should trim English conversational fillers", () => {
    const raw = "can you please kindly fix the compilation error thanks";
    const cleaned = trimConversationalNoise(raw);
    expect(cleaned).toBe("fix the compilation error");
  });

  it("should preserve pure technical commands", () => {
    const raw = "bun run test";
    const cleaned = trimConversationalNoise(raw);
    expect(cleaned).toBe("bun run test");
  });
});
