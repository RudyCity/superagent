import { describe, it, expect } from "vitest";
import { getHistoryDb, closeHistoryDb } from "../src/core/storage/historyDb.js";
import { ContextManager } from "../src/core/context/ContextManager.js";

describe("Memory Leak Prevention and Crash Hygiene", () => {
  it("should cache prepared statements in historyDb to prevent native handle leaks", () => {
    const db = getHistoryDb();
    const query = "SELECT 1 as val";
    const stmt1 = db.prepare(query);
    const stmt2 = db.prepare(query);

    // Verify statement object reuse
    expect(stmt1).toBe(stmt2);
    expect(stmt1.get().val).toBe(1);
    expect(stmt2.get().val).toBe(1);
  });

  it("should enforce in-memory working limit for models with massive context windows", () => {
    // Model with 1.05M tokens (like minimax-m3 or gemini)
    const cm = new ContextManager({
      model: "minimax/minimax-m3:free",
      contextWindowLimit: 1048576,
    });

    // Access private calculateThreshold via any
    const threshold = (cm as any).calculateThreshold();

    // Default in-memory working limit is 128,000 tokens
    // Rather than allowing threshold to swell to 838,860 tokens, it must be capped at 128,000
    expect(threshold).toBeLessThanOrEqual(128000);
    expect(threshold).toBeGreaterThan(50000);
  });

  it("should preserve normal threshold for standard context window sizes", () => {
    // Model with 128K tokens
    const cm = new ContextManager({
      model: "gpt-4o",
      contextWindowLimit: 128000,
    });

    const threshold = (cm as any).calculateThreshold();
    // For 128K, threshold should be around 80% (102,400)
    expect(threshold).toBeLessThanOrEqual(128000);
    expect(threshold).toBeGreaterThan(90000);
  });
});
