import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { registerProject, removeProject } from "../src/core/project/projectRegistry.js";
import { hasProjectAccess } from "../src/core/project/projectAccessPolicy.js";
import { setFullYoloMode } from "../src/core/permissions.js";

let configDir: string;
let previousConfigDir: string | undefined;
let projectA: string;
let projectB: string;
const projectAId = "independent-local-a";
const projectBId = "independent-local-b";
const identity = { mode: "static-bearer" as const, subject: "bearer", credentialHash: "c".repeat(64) };

function toolText(result: any): string {
  return (result?.content ?? []).map((part: any) => part.text ?? "").join("\n");
}

beforeEach(() => {
  previousConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-independent-config-"));
  process.env.SUPERAGENT_CONFIG_DIR = configDir;
  projectA = path.join(process.cwd(), ".tmp-mcp-independent-a-" + process.pid + "-" + Date.now());
  projectB = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-independent-b-"));
  fs.mkdirSync(projectA, { recursive: true });
  fs.writeFileSync(path.join(projectA, "from-a.txt"), "alpha project marker");
  fs.writeFileSync(path.join(projectB, "from-b.txt"), "bravo project marker");
  fs.writeFileSync(path.join(projectB, ".env.local"), "TEST_SECRET=must-not-be-read");
  registerProject({ id: projectAId, name: "Independent A", type: "local", root: projectA });
  registerProject({ id: projectBId, name: "Independent B", type: "local", root: projectB });
  setFullYoloMode(false);
});

afterEach(() => {
  setFullYoloMode(false);
  removeProject(projectAId);
  removeProject(projectBId);
  if (previousConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = previousConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectA, { recursive: true, force: true });
  fs.rmSync(projectB, { recursive: true, force: true });
});

describe("independent multi-project operations through the MCP dispatcher", () => {
  it("uses two unrelated local project roots in one MCP server without switching the session default", async () => {
    const server = createSuperagentMcpServer({
      workspace: projectA,
      allowDangerous: true,
      getIdentity: () => identity,
    });
    const rawCall = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const call = async (request: any) => {
      try {
        return await rawCall(request);
      } catch (error) {
        // The SDK may reject at the outer Scoped YOLO guard before dispatch,
        // while remote MCP clients receive an ordinary JSON-RPC error response.
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    };

    const deniedB = await call({
      method: "tools/call",
      params: { name: "superagent_list_files", arguments: { projectId: projectBId } },
    });
    expect(deniedB.isError).toBeTruthy();
    expect(toolText(deniedB)).toMatch(/outside the allowed workspace scope|access is not granted/i);

    setFullYoloMode(true);
    const grant = await call({
      method: "tools/call",
      params: { name: "superagent_grant_project_access", arguments: { projectId: projectBId, capabilities: ["read"] } },
    });
    expect(grant.isError).toBeFalsy();
    expect(hasProjectAccess(identity, projectBId, "read")).toBe(true);
    setFullYoloMode(false);

    const readB = await call({
      method: "tools/call",
      params: { name: "superagent_list_files", arguments: { projectId: projectBId } },
    });
    expect(readB.isError).toBeFalsy();
    expect(toolText(readB)).toContain("from-b.txt");
    expect(toolText(readB)).not.toContain("from-a.txt");

    const envRead = await call({
      method: "tools/call",
      params: { name: "superagent_read_files", arguments: { projectId: projectBId, files: [".env.local"] } },
    });
    expect(envRead.isError).toBeTruthy();
    expect(toolText(envRead)).toMatch(/\.env files.*Full YOLO/i);
    expect(toolText(envRead)).not.toContain("TEST_SECRET=must-not-be-read");

    // Two independent calls can route concurrently without one AsyncLocalStorage
    // workspace context leaking into the other call.
    const [readAConcurrent, readBConcurrent] = await Promise.all([
      call({ method: "tools/call", params: { name: "superagent_list_files", arguments: { projectId: projectAId } } }),
      call({ method: "tools/call", params: { name: "superagent_list_files", arguments: { projectId: projectBId } } }),
    ]);
    expect(toolText(readAConcurrent)).toContain("from-a.txt");
    expect(toolText(readAConcurrent)).not.toContain("from-b.txt");
    expect(toolText(readBConcurrent)).toContain("from-b.txt");
    expect(toolText(readBConcurrent)).not.toContain("from-a.txt");

    const deniedWrite = await call({
      method: "tools/call",
      params: { name: "superagent_write_files", arguments: {
        projectId: projectBId,
        files: [{ filePath: "should-not-exist.txt", content: "must be denied" }],
      } },
    });
    expect(deniedWrite.isError).toBeTruthy();
    expect(fs.existsSync(path.join(projectB, "should-not-exist.txt"))).toBe(false);

    const defaultWorkspace = await call({
      method: "tools/call",
      params: { name: "superagent_get_workspace", arguments: {} },
    });
    expect(toolText(defaultWorkspace)).toContain(projectA);
    expect(toolText(defaultWorkspace)).not.toContain(projectB);

    const switched = await call({
      method: "tools/call",
      params: { name: "superagent_switch_workspace", arguments: { projectId: projectBId } },
    });
    expect(switched.isError).toBeFalsy();

    const lockedDefault = await call({
      method: "tools/call",
      params: { name: "superagent_get_workspace", arguments: {} },
    });
    expect(toolText(lockedDefault)).toContain(projectB);

    const deniedProjectRemoval = await call({
      method: "tools/call",
      params: { name: "superagent_remove_project", arguments: { projectId: projectBId } },
    });
    expect(deniedProjectRemoval.isError).toBeTruthy();
    expect(toolText(deniedProjectRemoval)).toMatch(/Scoped YOLO boundary/i);
    expect((await import("../src/core/project/projectRegistry.js")).getProject(projectBId)).not.toBeNull();

    const deniedDefaultWrite = await call({
      method: "tools/call",
      params: { name: "superagent_write_files", arguments: {
        files: [{ filePath: "default-workspace-write.txt", content: "must stay denied" }],
      } },
    });
    expect(deniedDefaultWrite.isError).toBeTruthy();
    expect(toolText(deniedDefaultWrite)).toMatch(/Scoped YOLO boundary|capability/i);
    expect(fs.existsSync(path.join(projectB, "default-workspace-write.txt"))).toBe(false);

    setFullYoloMode(true);
    const grantWrite = await call({
      method: "tools/call",
      params: { name: "superagent_grant_project_access", arguments: { projectId: projectBId, capabilities: ["read", "write"] } },
    });
    expect(grantWrite.isError).toBeFalsy();
    setFullYoloMode(false);

    const writeB = await call({
      method: "tools/call",
      params: { name: "superagent_write_files", arguments: {
        files: [{ filePath: "created-by-mcp.txt", content: "written into project B" }],
      } },
    });
    expect(writeB.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(projectB, "created-by-mcp.txt"), "utf8")).toBe("written into project B");
    expect(fs.existsSync(path.join(projectA, "created-by-mcp.txt"))).toBe(false);
  });
});
