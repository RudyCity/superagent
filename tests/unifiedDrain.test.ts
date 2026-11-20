import { describe, expect, it } from "vitest";
import { drainAllServices } from "../src/core/runtime/unifiedDrain.js";

describe("Unified Drain All Services", () => {
  it("orchestrates a safe, non-destructive drain across all background subsystems", async () => {
    const report = await drainAllServices({ corePort: 7888 });

    expect(report).toBeDefined();
    expect(typeof report.ok).toBe("boolean");
    expect(typeof report.timestamp).toBe("number");
    expect(Array.isArray(report.steps)).toBe(true);
    expect(report.steps.length).toBeGreaterThanOrEqual(5);

    const stepNames = report.steps.map((s) => s.name);
    expect(stepNames).toContain("Subagents & Active Tasks");
    expect(stepNames).toContain("Daemon Cron Scheduler");
    expect(stepNames).toContain("MCP Clients & Tunnels");
    expect(stepNames).toContain("Cloudflare Quick Tunnels");
    expect(stepNames).toContain("Muse & Telegram Watchers");
    expect(stepNames).toContain("Supervised Core API");

    for (const step of report.steps) {
      expect(typeof step.name).toBe("string");
      expect(typeof step.ok).toBe("boolean");
      expect(typeof step.message).toBe("string");
    }
  });
});
