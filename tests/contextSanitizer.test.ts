import { describe, it, expect } from "vitest";
import {
  scrubSecrets,
  truncateContextMessage,
  sanitizeTaskContext,
  scrubToolOutput,
} from "../src/core/remoteAgent/contextSanitizer.js";
import type { TaskContextMessage } from "../src/core/remoteAgent/protocol.js";

describe("contextSanitizer", () => {
  describe("scrubSecrets", () => {
    it("should redact Anthropic API keys", () => {
      const sampleKey = ["sk", "ant", "api03", "AbCdEf1234567890GhIjKlMnOpQrStUvWxYz"].join("-");
      const input = `Here is my key: ${sampleKey}-extra`;
      const result = scrubSecrets(input);
      expect(result).not.toContain("AbCdEf1234567890");
      expect(result).toContain("[REDACTED_ANTHROPIC_KEY]");
    });

    it("should redact OpenAI API keys", () => {
      const sampleKey = ["sk", "proj", "1234567890abcdef1234567890abcdef"].join("-");
      const input = `Connecting with ${sampleKey} in config`;
      const result = scrubSecrets(input);
      expect(result).not.toContain("1234567890abcdef");
      expect(result).toContain("[REDACTED_OPENAI_KEY]");
    });

    it("should redact Google Gemini API keys", () => {
      const sampleKey = ["AIzaSy", "D1234567890abcdef1234567890abc"].join("");
      const input = `Google key is ${sampleKey}`;
      const result = scrubSecrets(input);
      expect(result).not.toContain("D1234567890abcdef");
      expect(result).toContain("[REDACTED_GOOGLE_KEY]");
    });

    it("should redact GitHub Personal Access Tokens", () => {
      const samplePat1 = ["ghp", "1234567890abcdefghijklmnopqrstuvwxyzABCD"].join("_");
      const samplePat2 = ["github", "pat", "11AAAAAAA01234567890abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
      const input = `Token: ${samplePat1} or ${samplePat2}`;
      const result = scrubSecrets(input);
      expect(result).not.toContain("1234567890abcdef");
      expect(result).toContain("[REDACTED_GITHUB_TOKEN]");
    });

    it("should redact AWS Access Key IDs", () => {
      const sampleAws = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
      const input = `AWS_ACCESS_KEY_ID=${sampleAws}`;
      const result = scrubSecrets(input);
      expect(result).not.toContain(sampleAws);
      expect(result).toContain("[REDACTED_AWS_KEY]");
    });

    it("should redact Slack tokens", () => {
      const sampleSlack = ["xoxb", "1234567890", "1234567890123", "abcdef1234567890"].join("-");
      const input = `Bot token: ${sampleSlack}`;
      const result = scrubSecrets(input);
      expect(result).not.toContain("1234567890123");
      expect(result).toContain("[REDACTED_SLACK_TOKEN]");
    });

    it("should redact Private Key Blocks", () => {
      const input = [
        "Here is the key:",
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEowIBAAKCAQEA0m4w1r2k8s...",
        "-----END RSA PRIVATE KEY-----",
        "Done.",
      ].join("\n");
      const result = scrubSecrets(input);
      expect(result).not.toContain("MIIEowIBAAKCAQEA0m4w1r2k8s");
      expect(result).toContain("[REDACTED_PRIVATE_KEY_BLOCK]");
    });

    it("should redact Bearer authorization tokens", () => {
      const token = ["abcdef1234567890", "abcdef1234567890"].join("");
      const input = `Authorization: Bearer ${token}`;
      const result = scrubSecrets(input);
      expect(result).not.toContain(token);
      expect(result).toContain("Bearer [REDACTED_BEARER_TOKEN]");
    });

    it("should redact database passwords in connection strings", () => {
      const input = "postgres://admin:superSecretPassword123@localhost:5432/mydb";
      const result = scrubSecrets(input);
      expect(result).not.toContain("superSecretPassword123");
      expect(result).toContain("postgres://admin:[REDACTED_PASSWORD]@localhost:5432/mydb");
    });

    it("should redact environment variable secrets", () => {
      const input = 'API_KEY="my-secret-key-12345"\nJWT_SECRET=superSecretValue987';
      const result = scrubSecrets(input);
      expect(result).not.toContain("my-secret-key-12345");
      expect(result).not.toContain("superSecretValue987");
      expect(result).toContain("[REDACTED_SECRET]");
    });

    it("should redact custom known secrets", () => {
      const customSecret = "super-custom-ws-token-xyz123";
      const input = `Connecting with custom token: ${customSecret} on port 9225`;
      const result = scrubSecrets(input, [customSecret]);
      expect(result).not.toContain(customSecret);
      expect(result).toContain("[REDACTED_SECRET]");
    });
  });

  describe("truncateContextMessage", () => {
    it("should not truncate short messages under maxChars", () => {
      const input = "Short message that fits comfortably within budget.";
      expect(truncateContextMessage(input, 500)).toBe(input);
    });

    it("should truncate long messages preserving head and tail", () => {
      const longText = "A".repeat(1000) + "MIDDLE_CONTENT" + "Z".repeat(1000);
      const truncated = truncateContextMessage(longText, 500);
      expect(truncated.length).toBeLessThan(longText.length);
      expect(truncated).toContain("[... truncated");
      expect(truncated.startsWith("AAAAA")).toBe(true);
      expect(truncated.endsWith("ZZZZZ")).toBe(true);
    });
  });

  describe("sanitizeTaskContext", () => {
    it("should return empty array when no messages provided", () => {
      expect(sanitizeTaskContext([])).toEqual([]);
    });

    it("should filter out empty or blank messages", () => {
      const msgs: TaskContextMessage[] = [
        { role: "user", content: "   " },
        { role: "assistant", content: "" },
        { role: "user", content: "Valid message" },
      ];
      const result = sanitizeTaskContext(msgs);
      expect(result.length).toBe(1);
      expect(result[0].content).toBe("Valid message");
    });

    it("should scrub secrets from all messages", () => {
      const fakeAnt = ["sk", "ant", "api03", "1234567890abcdef1234567890"].join("-");
      const fakeGhp = ["ghp", "1234567890abcdefghijklmnopqrstuvwxyz1234"].join("_");
      const msgs: TaskContextMessage[] = [
        { role: "user", content: `My key is ${fakeAnt}` },
        { role: "assistant", content: `Token generated: ${fakeGhp}` },
      ];
      const result = sanitizeTaskContext(msgs);
      expect(result[0].content).toContain("[REDACTED_ANTHROPIC_KEY]");
      expect(result[1].content).toContain("[REDACTED_GITHUB_TOKEN]");
    });

    it("should bound the number of messages to maxMessages", () => {
      const msgs: TaskContextMessage[] = Array.from({ length: 25 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i + 1}`,
      }));
      const result = sanitizeTaskContext(msgs, { maxMessages: 5 });
      expect(result.length).toBe(5);
      expect(result[0].content).toBe("Message 21");
      expect(result[4].content).toBe("Message 25");
    });

    it("should enforce total character budget prioritizing newest messages", () => {
      const msgs: TaskContextMessage[] = [
        { role: "user", content: "Old message ".repeat(50) },
        { role: "assistant", content: "Intermediate response ".repeat(50) },
        { role: "user", content: "Latest instruction" },
      ];
      const result = sanitizeTaskContext(msgs, { maxTotalChars: 500 });
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[result.length - 1].content).toBe("Latest instruction");
    });
  });

  describe("scrubToolOutput", () => {
    it("should scrub credentials from command/tool outputs", () => {
      const fakeProjKey = ["sk", "proj", "99999999999999999999999999"].join("-");
      const toolOutput = `cat .env output:\nDATABASE_URL=postgres://root:myPassword123@db:5432/prod\nAPI_KEY=${fakeProjKey}\n`;
      const result = scrubToolOutput(toolOutput);
      expect(result).not.toContain("myPassword123");
      expect(result).not.toContain(fakeProjKey);
      expect(result).toContain("[REDACTED_PASSWORD]");
      expect(result).toContain("[REDACTED_OPENAI_KEY]");
    });
  });
});
