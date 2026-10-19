import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(() => ({ running: true, pid: 123 })),
  listJobs: vi.fn(),
  listDaemonRuns: vi.fn(),
  getDaemonRun: vi.fn(),
}));

vi.mock("../src/core/daemon/daemonScheduler.js", () => ({
  daemonScheduler: { getStatus: mocks.getStatus, listJobs: mocks.listJobs },
}));
vi.mock("../src/core/storage/daemonRunLedger.js", () => ({
  listDaemonRuns: mocks.listDaemonRuns,
  getDaemonRun: mocks.getDaemonRun,
}));

import {
  DIAGNOSTICS_MCP_TOOL_CLASSIFICATIONS,
  DIAGNOSTICS_MCP_TOOL_DEFS,
  dispatchDiagnosticsMcpTool,
} from "../src/core/mcp/tools/diagnosticsMcpTools.js";
import { WORKSPACE_SCOPED_MCP_TOOLS } from "../src/core/mcp/mcpWorkspacePolicy.js";
import { runWithMcpWorkspace } from "../src/core/mcp/tools/workspaceContext.js";

describe("daemon MCP read-only diagnostics", () => {
  let workspace: string;
  let otherWorkspace: string;
  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-daemon-project-")));
    otherWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-daemon-foreign-")));
    mocks.listJobs.mockReset();
    mocks.getStatus.mockClear();
    mocks.listDaemonRuns.mockReset();
    mocks.getDaemonRun.mockReset();
  });

  afterEach(() => {
    fs.rmSync(workspace, { force: true, recursive: true });
    fs.rmSync(otherWorkspace, { force: true, recursive: true });
  });

  it("registers two read-only tools behind MCP workspace access policy", () => {
    for (const name of ["superagent_daemon_status", "superagent_daemon_inspect_run"]) {
      expect(DIAGNOSTICS_MCP_TOOL_CLASSIFICATIONS[name]).toBe("safe");
      expect(WORKSPACE_SCOPED_MCP_TOOLS.has(name)).toBe(true);
      expect(DIAGNOSTICS_MCP_TOOL_DEFS.some((tool) => tool.name === name)).toBe(true);
    }
  });

  it("returns only current-project jobs and run summaries, with bounded limits", async () => {
    mocks.listJobs.mockReturnValue([
      { id: "a", name: "local", workspace },
      { id: "b", name: "foreign", workspace: otherWorkspace },
    ]);
    mocks.listDaemonRuns.mockReturnValue([
      { runId: "run-a", jobId: "a", workspacePath: workspace, status: "running" },
      { runId: "run-b", jobId: "b", workspacePath: otherWorkspace, status: "success" },
    ]);
    const result = await runWithMcpWorkspace(workspace, () =>
      dispatchDiagnosticsMcpTool("superagent_daemon_status", { limit: 3 }));
    expect(result?.isError).not.toBe(true);
    const rendered = JSON.parse((result?.content[0] as any)?.text);
    expect(rendered.projectScheduledJobs).toBe(1);
    expect(rendered.jobs.map((job: any) => job.id)).toEqual(["a"]);
    expect(rendered.recentRuns.map((run: any) => run.runId)).toEqual(["run-a"]);
    expect(mocks.listDaemonRuns).toHaveBeenCalledWith({ workspacePath: workspace, limit: 3 });
  });

  it("rejects cross-project run IDs without revealing their details", async () => {
    mocks.getDaemonRun.mockReturnValue({
      runId: "foreign-run", workspacePath: otherWorkspace, errorMessage: "private",
    });
    const denied = await runWithMcpWorkspace(workspace, () =>
      dispatchDiagnosticsMcpTool("superagent_daemon_inspect_run", { runId: "foreign-run" }));
    expect(denied?.isError).toBe(true);
    expect((denied?.content[0] as any).text).not.toContain("private");
  });

  it("inspects local run ID and validates arguments without causing side effects", async () => {
    mocks.getDaemonRun.mockReturnValue({
      runId: "local-run", workspacePath: workspace, status: "failed", outputSummary: "status checked",
    });
    const result = await runWithMcpWorkspace(workspace, () =>
      dispatchDiagnosticsMcpTool("superagent_daemon_inspect_run", { runId: "local-run" }));
    expect(result?.isError).not.toBe(true);
    expect((result?.content[0] as any).text).toContain("status checked");
    const invalid = await runWithMcpWorkspace(workspace, () =>
      dispatchDiagnosticsMcpTool("superagent_daemon_status", { limit: 999 }));
    expect(invalid?.isError).toBe(true);
  });
});
