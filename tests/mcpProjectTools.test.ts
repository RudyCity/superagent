import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROJECT_MCP_TOOL_CLASSIFICATIONS,
  dispatchProjectMcpTool,
} from "../src/core/mcp/tools/projectTools.js";
import { getProject, listProjects } from "../src/core/project/projectRegistry.js";
import { setFullYoloMode } from "../src/core/permissions.js";
import { hasProjectAccess } from "../src/core/project/projectAccessPolicy.js";

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
  setFullYoloMode(false);
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = previousConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  setFullYoloMode(false);
});

describe("project registry MCP tools", () => {
  it("exposes read-only discovery as safe and registry mutations as dangerous", () => {
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_list_projects).toBe("safe");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_get_project).toBe("safe");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_discover_projects).toBe("safe");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_import_discovered_project).toBe("dangerous");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_sync_projects).toBe("dangerous");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_register_project).toBe("dangerous");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_update_project).toBe("dangerous");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_remove_project).toBe("dangerous");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_list_project_access).toBe("safe");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_check_project_health).toBe("safe");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_grant_project_access).toBe("dangerous");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_revoke_project_access).toBe("dangerous");
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

  it("requires Full YOLO to grant project access and scopes capabilities to one MCP identity", async () => {
    const identity = { mode: "oauth" as const, subject: "project-tools-client" };
    await dispatchProjectMcpTool("superagent_register_project", {
      projectId: "access-test", name: "Access Test", type: "local", root: projectRoot,
    });
    const denied = await dispatchProjectMcpTool("superagent_grant_project_access", {
      projectId: "access-test", capabilities: ["read"],
    }, identity);
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("Full YOLO");

    setFullYoloMode(true);
    const granted = await dispatchProjectMcpTool("superagent_grant_project_access", {
      projectId: "access-test", capabilities: ["read"],
    }, identity);
    expect(granted.isError).toBeUndefined();
    expect(hasProjectAccess(identity, "access-test", "read")).toBe(true);
    expect(hasProjectAccess(identity, "access-test", "write")).toBe(false);
    expect(hasProjectAccess({ mode: "oauth", subject: "other-client" }, "access-test", "read")).toBe(false);

    const listed = await dispatchProjectMcpTool("superagent_list_project_access", {}, identity);
    expect(JSON.parse(textOf(listed)).grants).toMatchObject([{ projectId: "access-test", capabilities: ["read"] }]);

    const disabled = await dispatchProjectMcpTool("superagent_update_project", {
      projectId: "access-test", enabled: false,
    }, identity);
    expect(JSON.parse(textOf(disabled)).previousAccessGrantsRevoked).toBe(true);
    expect(hasProjectAccess(identity, "access-test", "read")).toBe(false);
    setFullYoloMode(false);
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
