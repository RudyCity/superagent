import { describe, it, expect, vi } from "vitest";
import http from "http";
import { registry } from "../src/core/commands/registry.js";
import "../src/core/commands/selfdevCommand.js";
import { startGatewayServer } from "../src/core/gateway/gatewayServer.js";
import { synthesizeSkill, validateSkillMarkdown } from "../src/core/skills/skillSynthesizer.js";

describe("Self-Dev, Gateway & Skills Enhancement Suite", () => {
  const createMockContext = () => {
    const lines: any[] = [];
    return {
      addLine: (line: any) => lines.push(line),
      getLines: () => lines,
      agent: {
        workingDirectory: process.cwd(),
        isMultiAgent: false,
        getHistory: () => ({
          getMessages: () => [
            { role: "user", content: "Optimize database indexes" },
            { role: "assistant", content: "Executing EXPLAIN QUERY PLAN" },
          ],
        }),
      } as any,
      setActiveWizard: vi.fn(),
      setIsProcessing: vi.fn(),
      setWizardOptions: vi.fn(),
      setWizardSelectedIndex: vi.fn(),
    };
  };

  describe("/selfdev command", () => {
    it("is registered in the command registry", () => {
      const cmd = registry.get("selfdev");
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("selfdev");
    });

    it("executes status subcommand and reports self-dev metrics", async () => {
      const cmd = registry.get("selfdev");
      const ctx = createMockContext();
      await cmd?.execute("status", ctx as any);
      const lines = ctx.getLines();
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].content).toContain("Self-Development Engine Status:");
    });

    it("executes list subcommand without throwing", async () => {
      const cmd = registry.get("selfdev");
      const ctx = createMockContext();
      await cmd?.execute("list", ctx as any);
      const lines = ctx.getLines();
      expect(lines.length).toBeGreaterThan(0);
    });

    it("toggles enabled state via enable and disable", async () => {
      const cmd = registry.get("selfdev");
      const ctx1 = createMockContext();
      await cmd?.execute("enable", ctx1 as any);
      expect(ctx1.getLines()[0].content).toContain("Self-Development engine enabled.");

      const ctx2 = createMockContext();
      await cmd?.execute("disable", ctx2 as any);
      expect(ctx2.getLines()[0].content).toContain("Self-Development engine disabled.");
    });

    it("runs maybeAutoDistill safely without errors", async () => {
      const { maybeAutoDistill } = await import("../src/core/selfdev/selfdevAgent.js");
      const count = await maybeAutoDistill(process.cwd());
      expect(typeof count).toBe("number");
    });
  });

  describe("Standalone Gateway Listener", () => {
    it("starts an HTTP gateway server and responds to /health endpoint", async () => {
      const testPort = 18991;
      const { server, port } = await startGatewayServer({
        port: testPort,
        silent: true,
      });

      expect(port).toBe(testPort);

      // Verify health check response
      const healthData = await new Promise<any>((resolve, reject) => {
        http.get(`http://localhost:${testPort}/health`, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(err);
            }
          });
          res.on("error", reject);
        });
      });

      expect(healthData.status).toBe("ok");
      expect(healthData.service).toBe("superagent-gateway");
      expect(healthData.gateway).toBeDefined();

      // Close server
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("handles missing bot token in startTelegramPolling with descriptive error", async () => {
      const { startTelegramPolling } = await import("../src/core/gateway/telegramPoller.js");
      await expect(
        startTelegramPolling({ botToken: "", silent: true })
      ).rejects.toThrow("No Telegram bot token configured");
    });
  });

  describe("Skill Synthesis Engine", () => {
    it("validates skill markdown structure correctly", () => {
      const validMarkdown = `---
name: test-skill
description: A test skill for validation
category: testing
---

# Test Skill

## When to Use
Use this skill when testing the validator.

## Step-by-Step Workflow
1. Execute unit tests.
2. Confirm all tests pass.
`;
      const result = validateSkillMarkdown(validMarkdown);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it("rejects invalid skill markdown missing required sections", () => {
      const invalidMarkdown = `---
name: bad-skill
---

# Incomplete Skill
`;
      const result = validateSkillMarkdown(invalidMarkdown);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("synthesizes a new skill to disk and validates it", async () => {
      const skill = await synthesizeSkill({
        taskDescription: "Automate git worktree creation and safety verification",
        skillName: "temp-test-skill-synthesizer",
        category: "git",
      });

      expect(skill.name).toBe("temp-test-skill-synthesizer");
      expect(skill.category).toBe("git");
      expect(skill.filePath).toContain("SKILL.md");
      expect(skill.markdownContent).toContain("# Temp Test Skill Synthesizer");
      expect(skill.markdownContent).toContain("## Step-by-Step Workflow");

      // Clean up temporary synthesized skill directory
      const fs = await import("fs");
      const path = await import("path");
      try {
        fs.rmSync(path.dirname(skill.filePath), { recursive: true, force: true });
      } catch {}
    });
  });
});
