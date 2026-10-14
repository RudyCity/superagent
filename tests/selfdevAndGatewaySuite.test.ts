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

    it("inspect command remains workspace-scoped when a lesson ID is unknown", async () => {
      const cmd = registry.get("selfdev");
      const ctx = createMockContext();
      await cmd?.execute("inspect no-such-selfdev-lesson-id", ctx as any);
      const content = ctx.getLines().map((line: any) => line.content).join("\\n");
      expect(content).toContain("Lesson not found in the current workspace.");
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

    it("coalesces concurrent automatic distillation for the same workspace", async () => {
      const { getSelfDevConfig, updateSelfDevConfig } = await import("../src/core/selfdev/settings.js");
      const { maybeAutoDistill, getSelfDevRuntimeMetrics, resetSelfDevRuntimeMetrics, resetSelfDevCollector } = await import("../src/core/selfdev/selfdevAgent.js");
      const original = getSelfDevConfig();
      updateSelfDevConfig({ enabled: true, collectionEnabled: true });
      resetSelfDevRuntimeMetrics();
      const workspace = `selfdev-coalesce-${process.pid}-${Date.now()}`;
      try {
        await Promise.all([
          maybeAutoDistill(workspace),
          maybeAutoDistill(workspace),
          maybeAutoDistill(workspace),
        ]);
        const metrics = getSelfDevRuntimeMetrics();
        expect(metrics.distillationRuns).toBe(1);
        expect(metrics.distillationCoalesced).toBe(2);
      } finally {
        resetSelfDevCollector();
        updateSelfDevConfig({
          enabled: original.enabled,
          collectionEnabled: original.collectionEnabled,
          injectionEnabled: original.injectionEnabled,
        });
        resetSelfDevRuntimeMetrics();
      }
    });

    it("runs read-only Selfdev doctor diagnostics", async () => {
      const cmd = registry.get("selfdev");
      const ctx = createMockContext();
      await cmd?.execute("doctor", ctx as any);
      const content = ctx.getLines().map((line: any) => line.content).join("\n");
      expect(content).toContain("Selfdev Doctor (read-only):");
      expect(content).toContain("Effective configuration");
      expect(content).toContain("History database");
    });

    it("records actual lesson injection idempotently in the feedback store", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const root = path.resolve("tmp");
      await fs.mkdir(root, { recursive: true });
      const dir = await fs.mkdtemp(path.join(root, "selfdev-injection-feedback-"));
      const storePath = path.join(dir, "lessons.json");
      const { getSelfDevConfig } = await import("../src/core/selfdev/settings.js");
      const { updateSettings } = await import("../src/core/config/jsonConfig.js");
      const { buildSelfDevInjectionBlock, resetSelfDevCollector } = await import("../src/core/selfdev/selfdevAgent.js");
      const { getHistoryDb } = await import("../src/core/storage/historyDb.js");
      const original = getSelfDevConfig();
      const workspace = `selfdev-feedback-workspace-${process.pid}-${Date.now()}`;
      const sessionId = `selfdev-feedback-session-${Date.now()}`;
      const lessonId = `selfdev-feedback-lesson-${Date.now()}`;
      const now = Date.now();
      try {
        await fs.writeFile(storePath, JSON.stringify({
          schemaVersion: 1,
          updatedAt: now,
          lessons: [{
            id: lessonId,
            workspace,
            statement: "Run the focused test suite after changing a task lifecycle hook.",
            rationale: "Approved fixture used by the feedback telemetry test.",
            evidenceIds: ["verified-event-reference"],
            tags: ["test"],
            version: 1,
            status: "active",
            createdAt: now - 1_000,
            updatedAt: now,
            approvedBy: "test-reviewer",
            approvedAt: now - 500,
          }],
        }));
        const { updateSelfDevConfig } = await import("../src/core/selfdev/settings.js");
        updateSelfDevConfig({ enabled: true, injectionEnabled: true, storePath });
        resetSelfDevCollector();

        const first = await buildSelfDevInjectionBlock(workspace, sessionId);
        const second = await buildSelfDevInjectionBlock(workspace, sessionId);
        expect(first).toContain("Run the focused test suite");
        expect(second).toContain("Run the focused test suite");

        const db = getHistoryDb() as any;
        const rows = db.prepare(
          "SELECT metric FROM selfdev_feedback WHERE workspace = ? AND session_id = ? AND lesson_id = ? AND version = 1"
        ).all(workspace, sessionId, lessonId);
        expect(rows).toEqual([{ metric: "injected" }]);
      } finally {
        resetSelfDevCollector();
        updateSettings({ selfdev: original });
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("reports Selfdev learning metrics without exposing event text", async () => {
      const cmd = registry.get("selfdev");
      const ctx = createMockContext();
      await cmd?.execute("metrics", ctx as any);
      const content = ctx.getLines().map((line: any) => line.content).join("\n");
      expect(content).toContain("Selfdev Metrics");
      expect(content).toContain("Events by kind");
      expect(content).toContain("Current-process");
      expect(content).not.toContain("password=");
    });
    it("records events independently for two workspaces in the same process", async () => {
      const { getSelfDevConfig, updateSelfDevConfig } = await import("../src/core/selfdev/settings.js");
      const { getHistoryDb } = await import("../src/core/storage/historyDb.js");
      const { SelfDevEventStore } = await import("../src/core/selfdev/eventStore.js");
      const { recordSelfDevEvent, resetSelfDevCollector } = await import("../src/core/selfdev/selfdevAgent.js");
      const original = getSelfDevConfig();
      updateSelfDevConfig({ enabled: true, collectionEnabled: true });
      resetSelfDevCollector();
      const suffix = `${process.pid}-${Date.now()}`;
      const workspaceA = `selfdev-workspace-a-${suffix}`;
      const workspaceB = `selfdev-workspace-b-${suffix}`;
      try {
        expect(await recordSelfDevEvent({
          id: `event-a-${suffix}`, sessionId: `session-a-${suffix}`, workspace: workspaceA,
          kind: "custom", summary: "Workspace A evidence",
        })).toBe(true);
        expect(await recordSelfDevEvent({
          id: `event-b-${suffix}`, sessionId: `session-b-${suffix}`, workspace: workspaceB,
          kind: "custom", summary: "Workspace B evidence",
        })).toBe(true);

        const db = getHistoryDb() as any;
        const storeA = new SelfDevEventStore({ workspace: workspaceA, getDb: () => db, config: { enabled: true } });
        const storeB = new SelfDevEventStore({ workspace: workspaceB, getDb: () => db, config: { enabled: true } });
        expect(storeA.list({ limit: 10 }).map(event => event.id)).toEqual([`event-a-${suffix}`]);
        expect(storeB.list({ limit: 10 }).map(event => event.id)).toEqual([`event-b-${suffix}`]);
      } finally {
        resetSelfDevCollector();
        updateSelfDevConfig({
          enabled: original.enabled,
          collectionEnabled: original.collectionEnabled,
          injectionEnabled: original.injectionEnabled,
        });
      }
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

    it("handles missing bot token in startDiscordGateway with descriptive error", async () => {
      const { startDiscordGateway } = await import("../src/core/gateway/discordPoller.js");
      await expect(
        startDiscordGateway({ botToken: "", silent: true })
      ).rejects.toThrow("No Discord bot token configured");
    });

    it("handles unconfigured channels in startGatewayPolling with descriptive error", async () => {
      const { startGatewayPolling } = await import("../src/core/gateway/gatewayPoller.js");
      await expect(
        startGatewayPolling({ channels: "invalid-channel", silent: true })
      ).rejects.toThrow("not recognized or missing required credentials");
    });

    it("handles missing app/bot token in startSlackSocketMode with descriptive error", async () => {
      const { startSlackSocketMode } = await import("../src/core/gateway/slackPoller.js");
      await expect(
        startSlackSocketMode({ appToken: "", botToken: "", silent: true })
      ).rejects.toThrow("No Slack app-level token");
    });
  });

  describe("/selfdev review & /daemon top commands", () => {
    it("executes /selfdev review subcommand without error", async () => {
      const cmd = registry.get("selfdev");
      const ctx = createMockContext();
      await cmd?.execute("review", ctx as any);
      const lines = ctx.getLines();
      expect(lines.length).toBeGreaterThan(0);
    });

    it("executes /daemon top subcommand and renders dashboard", async () => {
      await import("../src/core/commands/daemonCommand.js");
      const cmd = registry.get("daemon");
      const ctx = createMockContext();
      await cmd?.execute("top", ctx as any);
      const lines = ctx.getLines();
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].content).toContain("Superagent Autonomous Daemon - Live Top / Dashboard");
    });

    it("renders daemon dashboard using renderDaemonDashboard helper", async () => {
      const { renderDaemonDashboard } = await import("../src/core/daemon/daemonScheduler.js");
      const dashboard = renderDaemonDashboard(
        { running: true, pid: 1234, uptime: 60, activeJobsCount: 0 },
        [
          {
            id: "test_job_1",
            name: "test-task",
            cronExpression: "0 0 * * *",
            prompt: "echo test",
            workspace: process.cwd(),
            mode: "single",
            enabled: true,
            runCount: 2,
            createdAt: Date.now(),
          },
        ]
      );
      expect(dashboard).toContain("test_job_1");
      expect(dashboard).toContain("ACTIVE");
      expect(dashboard).toContain("test-task");
    });
  });

  describe("Skill Execution Tracking & Stats", () => {
    it("records and retrieves skill execution stats", async () => {
      const { recordSkillExecution, getSkillStats } = await import("../src/core/skills/skillTracker.js");
      recordSkillExecution("test-tracker-skill");

      const stats = getSkillStats();
      const match = stats.find((s) => s.name === "test-tracker-skill");
      expect(match).toBeDefined();
      expect(match?.executionCount).toBeGreaterThanOrEqual(1);
    });

    it("executes /skills stats subcommand and displays metrics", async () => {
      await import("../src/core/commands/skillCommands.js");
      const cmd = registry.get("skills");
      const ctx = createMockContext();
      await cmd?.execute("stats", ctx as any);
      const lines = ctx.getLines();
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].content).toContain("Agent Skill Statistics & Tracking:");
    });

    it("executes /skills show subcommand for a known skill", async () => {
      const cmd = registry.get("skills");
      const ctx = createMockContext();
      await cmd?.execute("show tdd", ctx as any);
      const lines = ctx.getLines();
      expect(lines.length).toBeGreaterThan(0);
    });

    it("handles /skills run subcommand gracefully", async () => {
      const cmd = registry.get("skills");
      const ctx = createMockContext();
      await cmd?.execute("run non-existent-skill", ctx as any);
      const lines = ctx.getLines();
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].content).toContain("not found");
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
