import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  manageBackgroundProcessTool,
  inspectBackgroundLogTool,
  stripAnsi,
} from "../src/core/tools/backgroundProcessTools.js";
import { backgroundTasks } from "../src/core/tools/state.js";
import { getToolByName } from "../src/core/tools/index.js";
import {
  masterToolset,
  superagentToolset,
  subagentToolsets,
  chromeExtensionToolset,
} from "../src/core/tools/toolsets.js";

describe("Background Process Log Inspection, Grep, and Slice Suite", () => {
  const tempDir = path.join(os.tmpdir(), `superagent-bg-log-test-${Date.now()}`);
  let sampleLogFile: string;

  beforeEach(() => {
    backgroundTasks.clear();
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    sampleLogFile = path.join(tempDir, "sample-task.log");

    // Write a realistic multiline log
    const logLines = [
      "[2026-10-04T09:00:00Z] [laris-api] Initializing backend service...",
      "[2026-10-04T09:00:01Z] [laris-api] Loading configuration from model-config.json",
      "[2026-10-04T09:00:02Z] [laris-api] Connecting to SQLite database...",
      "[2026-10-04T09:00:03Z] [laris-api] Database connection established.",
      "[2026-10-04T09:00:04Z] [laris-api] Starting HTTP listener on port 7001",
      "[2026-10-04T09:00:05Z] [laris-api] Ready and listening at http://localhost:7001",
      "[2026-10-04T09:00:10Z] [laris-web] \u001b[32m[Vite]\u001b[0m Starting dev server...",
      "[2026-10-04T09:00:12Z] [laris-web] \u001b[33m[Warning]\u001b[0m Deprecated package detected",
      "[2026-10-04T09:00:15Z] [laris-web] Local: http://localhost:7002/",
      "[2026-10-04T09:01:00Z] [laris-api] GET /api/v1/health 200 OK - 1.2ms",
      "[2026-10-04T09:01:30Z] [laris-api] POST /api/v1/login 200 OK - 15.4ms",
      "[2026-10-04T09:02:00Z] [laris-api] \u001b[31m[ERROR]\u001b[0m Database connection timeout on query Q142",
      "[2026-10-04T09:02:01Z] [laris-api] Retrying connection attempt 1 of 3...",
      "[2026-10-04T09:02:05Z] [laris-api] Database reconnection successful.",
      "[2026-10-04T09:03:00Z] [laris-web] HMR update /src/components/Header.tsx",
    ];
    fs.writeFileSync(sampleLogFile, logLines.join("\n") + "\n", "utf-8");

    // Register active mock task pointing to sampleLogFile
    backgroundTasks.set("bg_laris", {
      id: "bg_laris",
      command: "bun run dev:laris",
      process: { pid: 21152, killed: false } as any,
      output: logLines.map((l) => l + "\n"),
      logPath: sampleLogFile,
      hasExited: false,
      cwd: tempDir,
    });
  });

  afterEach(() => {
    backgroundTasks.clear();
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe("Utility & ANSI Stripping", () => {
    it("should strip ANSI escape sequences accurately", () => {
      const colored = "\u001b[32mSuccess\u001b[0m and \u001b[31;1mError\u001b[0m";
      expect(stripAnsi(colored)).toBe("Success and Error");
    });
  });

  describe("grep and search action", () => {
    it("should find matching lines with case-insensitive search and context lines", async () => {
      const result = await manageBackgroundProcessTool.execute(
        {
          action: "grep",
          processId: "bg_laris",
          query: "database",
          contextLines: 1,
        },
        tempDir
      );

      expect(result).toContain("Search query: \"database\"");
      expect(result).toContain("bg_laris");
      expect(result).toContain("matches found");
      expect(result).toContain("> ");
      expect(result).toContain("Connecting to SQLite database");
      expect(result).toContain("Database reconnection successful");
    });

    it("should support regex queries with isRegex=true", async () => {
      const result = await manageBackgroundProcessTool.execute(
        {
          action: "search",
          processId: "bg_laris",
          query: "ERROR.*timeout",
          isRegex: true,
        },
        tempDir
      );

      expect(result).toContain("ERROR");
      expect(result).toContain("Database connection timeout");
    });

    it("should handle no matches gracefully", async () => {
      const result = await manageBackgroundProcessTool.execute(
        {
          action: "grep",
          processId: "bg_laris",
          query: "nonexistent_exception_code_9999",
        },
        tempDir
      );

      expect(result).toContain("No matching lines found");
      expect(result).toContain("Total lines searched: 15");
    });

    it("should require query parameter for grep", async () => {
      const result = await manageBackgroundProcessTool.execute(
        {
          action: "grep",
          processId: "bg_laris",
        },
        tempDir
      );

      expect(result).toContain("Error: query or pattern parameter is required");
    });
  });

  describe("slice and read action", () => {
    it("should read specific line slice with offset and limit", async () => {
      const result = await manageBackgroundProcessTool.execute(
        {
          action: "read",
          processId: "bg_laris",
          offset: 5,
          limit: 3,
        },
        tempDir
      );

      expect(result).toContain("Lines 5-7 of 15");
      expect(result).toContain("5 | ");
      expect(result).toContain("Starting HTTP listener on port 7001");
      expect(result).toContain("6 | ");
      expect(result).toContain("7 | ");
      expect(result).toContain("Next chunk: offset=8, limit=3");
    });

    it("should support negative offset counting backwards from end", async () => {
      const result = await manageBackgroundProcessTool.execute(
        {
          action: "slice",
          processId: "bg_laris",
          offset: -3,
          limit: 3,
        },
        tempDir
      );

      expect(result).toContain("Lines 13-15 of 15");
      expect(result).toContain("13 | ");
      expect(result).toContain("Retrying connection attempt");
      expect(result).toContain("15 | ");
      expect(result).toContain("HMR update");
    });
  });

  describe("tail and head action", () => {
    it("should read last N lines with tail action", async () => {
      const result = await manageBackgroundProcessTool.execute(
        {
          action: "tail",
          processId: "bg_laris",
          lines: 4,
        },
        tempDir
      );

      expect(result).toContain("Lines 12-15 of 15");
      expect(result).toContain("Database connection timeout");
      expect(result).toContain("HMR update");
    });

    it("should read first N lines with head action", async () => {
      const result = await manageBackgroundProcessTool.execute(
        {
          action: "head",
          processId: "bg_laris",
          lines: 3,
        },
        tempDir
      );

      expect(result).toContain("Lines 1-3 of 15");
      expect(result).toContain("Initializing backend service");
      expect(result).toContain("Loading configuration");
    });
  });

  describe("direct logPath inspection", () => {
    it("should inspect and grep direct logPath without requiring active process in memory", async () => {
      // Clear memory to simulate finished or disconnected process
      backgroundTasks.clear();

      const result = await manageBackgroundProcessTool.execute(
        {
          action: "grep",
          logPath: sampleLogFile,
          query: "listener",
        },
        tempDir
      );

      expect(result).toContain("Search query: \"listener\"");
      expect(result).toContain("Starting HTTP listener on port 7001");
      expect(result).toContain(sampleLogFile);
    });

    it("should read slice directly from logPath", async () => {
      backgroundTasks.clear();

      const result = await manageBackgroundProcessTool.execute(
        {
          action: "slice",
          logPath: sampleLogFile,
          offset: 1,
          limit: 2,
        },
        tempDir
      );

      expect(result).toContain("Lines 1-2 of 15");
      expect(result).toContain("Initializing backend service");
    });
  });

  describe("backward compatibility on status and logs actions", () => {
    it("should maintain standard format on logs action without parameters", async () => {
      const result = await manageBackgroundProcessTool.execute(
        {
          action: "logs",
          processId: "bg_laris",
        },
        tempDir
      );

      expect(result).toContain("Process: bun run dev:laris");
      expect(result).toContain("Output:");
      expect(result).toContain("Initializing backend service");
    });

    it("should automatically grep when query is provided in action: logs", async () => {
      const result = await manageBackgroundProcessTool.execute(
        {
          action: "logs",
          processId: "bg_laris",
          query: "HMR",
        },
        tempDir
      );

      expect(result).toContain("Search query: \"HMR\"");
      expect(result).toContain("HMR update /src/components/Header.tsx");
    });

    it("should automatically slice when offset and limit are provided in action: logs", async () => {
      const result = await manageBackgroundProcessTool.execute(
        {
          action: "logs",
          processId: "bg_laris",
          offset: 4,
          limit: 2,
        },
        tempDir
      );

      expect(result).toContain("Lines 4-5 of 15");
    });

    it("should show PID, status, and Log path in action: list", async () => {
      const listResult = await manageBackgroundProcessTool.execute(
        { action: "list" },
        tempDir
      );

      expect(listResult).toContain("Process ID: bg_laris");
      expect(listResult).toContain("PID: 21152");
      expect(listResult).toContain("Status: Running");
      expect(listResult).toContain("Command: bun run dev:laris");
      expect(listResult).toContain("Log: ");
    });
  });

  describe("inspect_background_log Dedicated Tool & Aliases", () => {
    it("should execute grep via inspect_background_log tool", async () => {
      const result = await inspectBackgroundLogTool.execute(
        {
          action: "grep",
          processId: "bg_laris",
          query: "7001",
        },
        tempDir
      );

      expect(result).toContain("Search query: \"7001\"");
      expect(result).toContain("http://localhost:7001");
    });

    it("should execute tail via inspect_background_log tool", async () => {
      const result = await inspectBackgroundLogTool.execute(
        {
          action: "tail",
          processId: "bg_laris",
          lines: 2,
        },
        tempDir
      );

      expect(result).toContain("Lines 14-15 of 15");
      expect(result).toContain("HMR update");
    });

    it("should resolve inspect_background_log by alias", () => {
      expect(getToolByName("inspect_background_log")?.name).toBe("inspect_background_log");
      expect(getToolByName("grep_background_log")?.name).toBe("inspect_background_log");
      expect(getToolByName("tail_background_log")?.name).toBe("inspect_background_log");
      expect(getToolByName("search_background_log")?.name).toBe("inspect_background_log");
      expect(getToolByName("read_background_log")?.name).toBe("inspect_background_log");
      expect(getToolByName("view_background_log")?.name).toBe("inspect_background_log");
    });

    it("should be registered in masterToolset, superagentToolset, chromeExtensionToolset, and subagents", () => {
      const masterNames = masterToolset.map((t) => t.name);
      expect(masterNames).toContain("inspect_background_log");

      const superagentNames = superagentToolset.map((t) => t.name);
      expect(superagentNames).toContain("inspect_background_log");

      const chromeNames = chromeExtensionToolset.map((t) => t.name);
      expect(chromeNames).toContain("inspect_background_log");

      const coderNames = subagentToolsets.coder.map((t) => t.name);
      expect(coderNames).toContain("inspect_background_log");

      const testerNames = subagentToolsets["software-tester"].map((t) => t.name);
      expect(testerNames).toContain("inspect_background_log");
      expect(testerNames).toContain("manage_background_process");

      const reviewerNames = subagentToolsets.reviewer.map((t) => t.name);
      expect(reviewerNames).toContain("inspect_background_log");

      const researcherNames = subagentToolsets.researcher.map((t) => t.name);
      expect(researcherNames).toContain("inspect_background_log");
    });
  });
});
