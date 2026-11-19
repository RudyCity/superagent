import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { onMcpActivity } from "../src/core/mcp/mcpActivityBus.js";
import { registerProject } from "../src/core/project/projectRegistry.js";
import { grantProjectAccess, hasProjectAccess, ProjectAccessPolicyStoreError } from "../src/core/project/projectAccessPolicy.js";
import { listProjectAccessRequests, MCP_CONNECTION_PROJECT_ID } from "../src/core/project/projectAccessRequestStore.js";

describe("MCP permission-store failure privacy", () => {
  let config: string;
  let previousConfig: string | undefined;
  let projectRoot: string;
  const sentinel = "PRIVATE_PATH_AND_CREDENTIAL_DO_NOT_ECHO";
  const identity = { mode: "oauth" as const, subject: "policy-store-reader",
    scopes: ["mcp:tools", "mcp:tools:write"], credentialHash: "a".repeat(64) };
  beforeEach(() => {
    previousConfig = process.env.SUPERAGENT_CONFIG_DIR;
    config = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-store-private-"));
    process.env.SUPERAGENT_CONFIG_DIR = config;
    projectRoot = path.join(config, sentinel);
    fs.mkdirSync(projectRoot);
    fs.writeFileSync(path.join(projectRoot, "input.txt"), "private test content");
    registerProject({ id: "store-test", name: "Store test", type: "local", root: projectRoot });
    grantProjectAccess(identity, "store-test", ["read", "write"]);
    grantProjectAccess(identity, MCP_CONNECTION_PROJECT_ID, ["execute"]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (previousConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = previousConfig;
    fs.rmSync(config, { recursive: true, force: true });
  });

  it.each(["invalid_json", "invalid_schema", "read_denied", "directory"] as const)(
    "denies project and connection calls through both routes with private %s storage", async kind => {
      const policy = path.join(config, "project-access.json");
      if (kind === "invalid_json") fs.writeFileSync(policy, "{" + sentinel);
      if (kind === "invalid_schema") fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, grants: [{ secret: sentinel }] }));
      if (kind === "directory") { fs.unlinkSync(policy); fs.mkdirSync(policy); }
      if (kind === "read_denied") {
        const read = fs.readFileSync;
        vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
          if (String(file) === policy)
            throw Object.assign(new Error("EACCES " + policy + " " + sentinel), { code: "EACCES" });
          return read(file, options) as ReturnType<typeof fs.readFileSync>;
        });
      }
      const audits: Array<Record<string, unknown>> = [];
      const activity: string[] = [];
      const unsubscribe = onMcpActivity(event => activity.push(JSON.stringify(event)));
      const server = createSuperagentMcpServer({ workspace: projectRoot, toolExposure: "gateway", authMode: "oauth",
        getIdentity: () => identity, onToolCall: event => audits.push(event as unknown as Record<string, unknown>) });
      const call = (server as any)._requestHandlers.get("tools/call");
      try {
        for (const gateway of [false, true]) {
          for (const [name, args] of [
            ["superagent_read_files", { projectId: "store-test", files: ["input.txt"] }],
            ["superagent_write_files", { projectId: "store-test", files: [{ filePath: "output.txt", content: sentinel }] }],
            ["superagent_desktop_ui", { command: "probe" }],
            ["superagent_desktop_ui", { command: "probe", projectId: sentinel }],
          ] as const) {
            let response: unknown;
            try {
              response = await call({ method: "tools/call", params: gateway
                ? { name: "superagent_tool_execute", arguments: { name, arguments: args } }
                : { name, arguments: args } });
            } catch (error) { response = error instanceof Error ? error.message : String(error); }
            const output = JSON.stringify(response);
            expect(output).toContain("POLICY_STORE_UNAVAILABLE");
            expect(output).not.toContain(config);
            expect(output).not.toContain(sentinel);
            expect(output).not.toContain(identity.credentialHash);
            expect(output).not.toContain("MCP_APPROVAL_REQUIRED");
          }
        }
        expect(audits.length).toBeGreaterThanOrEqual(6);
        expect(audits.every(event => event.errorCode === "policy_store_unavailable")).toBe(true);
        for (const output of [JSON.stringify(audits), JSON.stringify(activity)]) {
          expect(output).not.toContain(config);
          expect(output).not.toContain(sentinel);
          expect(output).not.toContain(identity.credentialHash);
        }
        expect(activity.length).toBeGreaterThanOrEqual(6);
        expect(fs.existsSync(path.join(projectRoot, "output.txt"))).toBe(false);
        expect(listProjectAccessRequests({ status: "pending" })).toHaveLength(0);
      } finally { unsubscribe(); await server.close(); }
    });

  it("treats only a missing optional store as empty and rechecks it after a valid grant", () => {
    const policy = path.join(config, "project-access.json");
    expect(hasProjectAccess(identity, "store-test", "read")).toBe(true);
    fs.unlinkSync(policy);
    expect(hasProjectAccess(identity, "store-test", "read")).toBe(false);
    fs.writeFileSync(policy, "{" + sentinel);
    expect(() => hasProjectAccess(identity, "store-test", "read")).toThrow(ProjectAccessPolicyStoreError);
    expect(() => hasProjectAccess(identity, "store-test", "read")).not.toThrow(sentinel);
  });
});
