import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROJECT_MCP_TOOL_CLASSIFICATIONS,
  dispatchProjectMcpTool,
} from "../src/core/mcp/tools/projectTools.js";
import { getProject, listProjects } from "../src/core/project/projectRegistry.js";

let configDir: string;
let previousConfigDir: string | undefined;
let projectRoot: string;

function textOf(result: any): string {
  return result?.content?.[0]?.text ?? "";
}

beforeEach(() => {
  previousConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-project-tools-config-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-project-tools-root-"));
  process.env.SUPERAGENT_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = previousConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("project registry MCP tools", () => {
  it("exposes read-only discovery as safe and registry mutations as dangerous", () => {
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_list_projects).toBe("safe");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_get_project).toBe("safe");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_register_project).toBe("dangerous");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_update_project).toBe("dangerous");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_remove_project).toBe("dangerous");
  });

  it("registers, lists, inspects, updates, and removes a project by stable ID", async () => {
    const created = await dispatchProjectMcpTool("superagent_register_project", {
      projectId: "api-tools-test",
      name: "API Tools Test",
      type: "local",
      root: projectRoot,
      tags: ["api", "typescript"],
    });
    expect(created.isError).toBeUndefined();
    expect(textOf(created)).toContain("api-tools-test");
    expect(getProject("api-tools-test")?.root).toBe(fs.realpathSync(projectRoot));

    const listed = await dispatchProjectMcpTool("superagent_list_projects", {});
    expect(JSON.parse(textOf(listed)).projects.map((item: any) => item.id)).toContain("api-tools-test");

    const inspected = await dispatchProjectMcpTool("superagent_get_project", { projectId: "api-tools-test" });
    expect(JSON.parse(textOf(inspected)).project.name).toBe("API Tools Test");

    const updated = await dispatchProjectMcpTool("superagent_update_project", { projectId: "api-tools-test", enabled: false, description: "disabled for a test" });
    expect(JSON.parse(textOf(updated)).updated.enabled).toBe(false);
    expect(getProject("api-tools-test")?.description).toBe("disabled for a test");

    const removed = await dispatchProjectMcpTool("superagent_remove_project", { projectId: "api-tools-test" });
    expect(JSON.parse(textOf(removed)).filesDeleted).toBe(false);
    expect(getProject("api-tools-test")).toBeNull();
  });

  it("rejects invalid project targets and duplicate registration without mutating the registry", async () => {
    const invalid = await dispatchProjectMcpTool("superagent_register_project", {
      projectId: "bad-remote",
      name: "Bad Remote",
      type: "ssh",
      target: "ssh://user:supersecret@example.test/app",
    });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toMatch(/password|credentials|secret/i);
    expect(listProjects()).toEqual([]);
  });
});
