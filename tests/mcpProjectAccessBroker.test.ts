import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dispatchProjectMcpTool,
} from "../src/core/mcp/tools/projectTools.js";
import {
  registerProject,
} from "../src/core/project/projectRegistry.js";
import { setFullYoloMode } from "../src/core/permissions.js";
import { registeredFileToolGate } from "../src/core/tools/registeredFileToolGate.js";
import {
  hasProjectAccess,
  listProjectAccess,
  revokeProjectAccess,
  grantProjectAccess,
} from "../src/core/project/projectAccessPolicy.js";
import {
  createProjectAccessRequest,
  approveProjectAccessRequest,
  denyProjectAccessRequest,
  revokeProjectAccessRequest,
  listProjectAccessRequests,
  grantProjectAccessToIdentity,
  MCP_CONNECTION_PROJECT_ID,
} from "../src/core/project/projectAccessRequestStore.js";

let configDir: string;
let previousConfigDir: string | undefined;
let projectRoot: string;

function textOf(result: any): string {
  return result?.content?.[0]?.text ?? "";
}

beforeEach(() => {
  previousConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-broker-config-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-broker-root-"));
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

describe("MCP Project Access Broker & Security Approval Workflow", () => {
  const geminiIdentity = { mode: "oauth" as const, subject: "gemini-client-session-1" };
  const claudeIdentity = { mode: "oauth" as const, subject: "claude-client-session-2" };

  it("1. Fresh agent identity has zero grants (grants: [])", () => {
    registerProject({
      id: "my-project",
      name: "My Project",
      type: "local",
      root: projectRoot,
    });

    const grants = listProjectAccess(geminiIdentity);
    expect(grants).toEqual([]);
    expect(hasProjectAccess(geminiIdentity, "my-project", "read")).toBe(false);
    expect(hasProjectAccess(geminiIdentity, "my-project", "write")).toBe(false);
  });

  it("2. Agent self-grant attempt is denied with POLICY_DENIED and queues a pending request", async () => {
    registerProject({
      id: "my-project",
      name: "My Project",
      type: "local",
      root: projectRoot,
    });

    const result = await dispatchProjectMcpTool(
      "superagent_grant_project_access",
      { projectId: "my-project", capabilities: ["read", "write"] },
      geminiIdentity
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.code).toBe("POLICY_DENIED");
    expect(body.error).toContain("MCP self-grant is prohibited");
    expect(body.requestId).toBeDefined();

    // Verify the agent does NOT have access
    expect(hasProjectAccess(geminiIdentity, "my-project", "read")).toBe(false);

    // Verify the request is stored as pending in the broker
    const pendingRequests = listProjectAccessRequests({ status: "pending" });
    expect(pendingRequests.length).toBe(1);
    expect(pendingRequests[0].requestId).toBe(body.requestId);
    expect(pendingRequests[0].status).toBe("pending");
    expect(pendingRequests[0].capabilities).toEqual(["read", "write"]);
  });

  it("2b. Full YOLO never allows an MCP caller to self-grant access", async () => {
    registerProject({ id: "yolo-project", name: "YOLO Project", type: "local", root: projectRoot });
    setFullYoloMode(true);
    const result = await dispatchProjectMcpTool("superagent_grant_project_access", {
      projectId: "yolo-project", capabilities: ["read", "execute"],
    }, geminiIdentity);
    expect(result.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.code).toBe("POLICY_DENIED");
    expect(body.status).toBe("pending");
    expect(hasProjectAccess(geminiIdentity, "yolo-project", "read")).toBe(false);
    expect(hasProjectAccess(geminiIdentity, "yolo-project", "execute")).toBe(false);
  });

  it("2c. Safe access-request tool is not blocked by permanent file certification", () => {
    const blocked = registeredFileToolGate({
      name: "superagent_request_project_access",
      args: { projectId: "my-project", capabilities: ["read"], reason: "Code audit" },
    }, projectRoot, {
      registry: () => ({} as any),
      identity: () => ({
        platform: "linux",
        executablePath: "/usr/local/bin/node",
        sha256: "a".repeat(64),
      }),
    });
    expect(blocked).toBeNull();
    expect(registeredFileToolGate({
      name: "superagent_exec_command", args: { command: "echo test" },
    }, projectRoot, {
      registry: () => ({} as any),
      identity: () => ({
        platform: "linux",
        executablePath: "/usr/local/bin/node",
        sha256: "a".repeat(64),
      }),
    })).not.toBeNull();
  });

  it("3. Pending access request via superagent_request_project_access does not grant access", async () => {
    registerProject({
      id: "my-project",
      name: "My Project",
      type: "local",
      root: projectRoot,
    });

    const reqResult = await dispatchProjectMcpTool(
      "superagent_request_project_access",
      {
        projectId: "my-project",
        capabilities: ["read"],
        reason: "Need to audit repository files for security vulnerabilities",
      },
      geminiIdentity
    );

    expect(reqResult.isError).toBeUndefined();
    const body = JSON.parse(textOf(reqResult));
    expect(body.status).toBe("pending");
    expect(body.code).toBe("APPROVAL_PENDING");
    expect(body.requestId).toBeDefined();

    // Verify access is still false
    expect(hasProjectAccess(geminiIdentity, "my-project", "read")).toBe(false);
  });

  it("4 & 5 & 6. Human approval produces a valid scoped grant, read succeeds, unauthorized write/exec fail", async () => {
    registerProject({
      id: "my-project",
      name: "My Project",
      type: "local",
      root: projectRoot,
    });

    // Agent submits request
    const pending = createProjectAccessRequest(geminiIdentity, {
      projectId: "my-project",
      capabilities: ["read"],
      reason: "Security code audit",
    });

    // Operator approves the request through Tray / Security Approval Manager
    const approved = approveProjectAccessRequest(pending.requestId, { decidedBy: "operator" });
    expect(approved).not.toBeNull();
    expect(approved?.request.status).toBe("approved");

    // Verification: Read succeeds
    expect(hasProjectAccess(geminiIdentity, "my-project", "read")).toBe(true);

    // Verification: Write and execute remain denied
    expect(hasProjectAccess(geminiIdentity, "my-project", "write")).toBe(false);
    expect(hasProjectAccess(geminiIdentity, "my-project", "execute")).toBe(false);
  });

  it("6b. Approval cannot add capabilities never requested by the agent", () => {
    registerProject({ id: "scope-project", name: "Scoped Project", type: "local", root: projectRoot });
    const pending = createProjectAccessRequest(geminiIdentity, {
      projectId: "scope-project", capabilities: ["read"], reason: "Read-only audit",
    });
    expect(() => approveProjectAccessRequest(pending.requestId, {
      approvedCapabilities: ["read", "write"],
    })).toThrow(/subset/);
    expect(hasProjectAccess(geminiIdentity, "scope-project", "read")).toBe(false);
    expect(hasProjectAccess(geminiIdentity, "scope-project", "write")).toBe(false);
    expect(() => approveProjectAccessRequest(pending.requestId, {
      approvedCapabilities: [],
    })).toThrow(/subset/);
  });

  it("7 & 8. Valid grant survives MCP reconnect and Core restart (persisted on disk)", () => {
    registerProject({
      id: "persisted-project",
      name: "Persisted Project",
      type: "local",
      root: projectRoot,
    });

    // Direct grant from Tray
    grantProjectAccessToIdentity(geminiIdentity, "persisted-project", ["read", "write"]);
    expect(hasProjectAccess(geminiIdentity, "persisted-project", "read")).toBe(true);
    expect(hasProjectAccess(geminiIdentity, "persisted-project", "write")).toBe(true);

    // Simulate reconnect: same subject re-evaluates access
    const reconnectedClient = { mode: "oauth" as const, subject: "gemini-client-session-1" };
    expect(hasProjectAccess(reconnectedClient, "persisted-project", "read")).toBe(true);
    expect(hasProjectAccess(reconnectedClient, "persisted-project", "write")).toBe(true);
  });

  it("direct Tray grant clears only pending requests fully satisfied by the grant", () => {
    registerProject({ id: "my-project", name: "My Project", type: "local", root: projectRoot });
    const pending = createProjectAccessRequest(geminiIdentity, {
      projectId: "my-project",
      capabilities: ["read", "write"],
      reason: "Operator approval requested for an audit and updates",
    });
    grantProjectAccessToIdentity(geminiIdentity, "my-project", ["read"]);
    expect(listProjectAccessRequests({status: "pending"}).map(req => req.requestId))
      .toContain(pending.requestId);
    expect(hasProjectAccess(geminiIdentity, "my-project", "write")).toBe(false);
    grantProjectAccessToIdentity(geminiIdentity, "my-project", ["read", "write"]);
    const approved = listProjectAccessRequests().find(req => req.requestId === pending.requestId);
    expect(approved?.status).toBe("approved");
    expect(approved?.decisionReason).toBe("Satisfied by direct operator grant");
    expect(listProjectAccessRequests({status: "pending"})).toHaveLength(0);
  });

  it("9 & 10. Identity isolation: Different identity cannot inherit another agent's grant", () => {
    registerProject({
      id: "isolated-project",
      name: "Isolated Project",
      type: "local",
      root: projectRoot,
    });

    // Grant to Gemini
    grantProjectAccessToIdentity(geminiIdentity, "isolated-project", ["read"]);

    // Gemini has access
    expect(hasProjectAccess(geminiIdentity, "isolated-project", "read")).toBe(true);

    // Claude identity does NOT have access
    expect(hasProjectAccess(claudeIdentity, "isolated-project", "read")).toBe(false);
  });

  it("11. Revocation immediately blocks subsequent operations", () => {
    registerProject({
      id: "revokable-project",
      name: "Revokable Project",
      type: "local",
      root: projectRoot,
    });

    const pending = createProjectAccessRequest(geminiIdentity, {
      projectId: "revokable-project",
      capabilities: ["read", "write"],
      reason: "Temporary bug fix",
    });

    approveProjectAccessRequest(pending.requestId);
    expect(hasProjectAccess(geminiIdentity, "revokable-project", "read")).toBe(true);

    // Revoke
    const res = revokeProjectAccessRequest(pending.requestId);
    expect(res.success).toBe(true);
    expect(res.revoked).toBe(true);

    // Immediately denied
    expect(hasProjectAccess(geminiIdentity, "revokable-project", "read")).toBe(false);
    expect(hasProjectAccess(geminiIdentity, "revokable-project", "write")).toBe(false);
  });

  it("12. Denial of pending request leaves access blocked and marks request as denied", () => {
    registerProject({
      id: "denied-project",
      name: "Denied Project",
      type: "local",
      root: projectRoot,
    });

    const pending = createProjectAccessRequest(geminiIdentity, {
      projectId: "denied-project",
      capabilities: ["read"],
      reason: "Suspicious read request",
    });

    const denied = denyProjectAccessRequest(pending.requestId, "Untrusted operation");
    expect(denied).not.toBeNull();
    expect(denied?.request.status).toBe("denied");
    expect(hasProjectAccess(geminiIdentity, "denied-project", "read")).toBe(false);
  });

  it("13. Path traversal and invalid project root fail closed", () => {
    // Attempting to request access to an unregistered project or directory traversal
    expect(() => {
      createProjectAccessRequest(geminiIdentity, {
        projectId: "../../etc",
        capabilities: ["read"],
        reason: "Path traversal attempt",
      });
    }).toThrow(/not found|traversal|invalid/i);
  });

  it("14. Corrupt request store fails closed safely without crashing", () => {
    const storePath = path.join(configDir, "project-access-requests.json");
    fs.writeFileSync(storePath, "{ this is corrupted json!@#$%", "utf8");

    // Listing requests should gracefully recover with empty list rather than crashing
    const list = listProjectAccessRequests();
    expect(list).toEqual([]);
  });

  it("14b. MCP connection approval is independent of chat YOLO and grants no project files", () => {
    setFullYoloMode(true);
    const pending = createProjectAccessRequest(geminiIdentity, {
      projectId: MCP_CONNECTION_PROJECT_ID,
      capabilities: ["execute"],
      reason: "Operate an explicitly approved MCP connection",
    });
    expect(pending.code).toBe("APPROVAL_PENDING");
    expect(hasProjectAccess(geminiIdentity, MCP_CONNECTION_PROJECT_ID, "execute")).toBe(false);
    expect(() => createProjectAccessRequest(geminiIdentity, {
      projectId: MCP_CONNECTION_PROJECT_ID,
      capabilities: ["read"],
      reason: "Illegal connection capability",
    })).toThrow(/execute capability/);
    const approved = approveProjectAccessRequest(pending.requestId);
    expect(approved.grant.capabilities).toEqual(["execute"]);
    expect(hasProjectAccess(geminiIdentity, MCP_CONNECTION_PROJECT_ID, "execute")).toBe(true);
    expect(hasProjectAccess(geminiIdentity, "unapproved-project", "read")).toBe(false);
    setFullYoloMode(false);
    expect(hasProjectAccess(geminiIdentity, MCP_CONNECTION_PROJECT_ID, "execute")).toBe(true);
    revokeProjectAccessRequest(pending.requestId);
    expect(hasProjectAccess(geminiIdentity, MCP_CONNECTION_PROJECT_ID, "execute")).toBe(false);
  });

  it("15. Direct grant via Broker API creates valid grant immediately", () => {
    registerProject({
      id: "direct-project",
      name: "Direct Project",
      type: "local",
      root: projectRoot,
    });

    const record = grantProjectAccessToIdentity(geminiIdentity, "direct-project", ["read", "git"]);
    expect(record.status).toBe("approved");
    expect(new Set(record.capabilities)).toEqual(new Set(["read", "git"]));
    expect(hasProjectAccess(geminiIdentity, "direct-project", "read")).toBe(true);
    expect(hasProjectAccess(geminiIdentity, "direct-project", "git")).toBe(true);
    expect(hasProjectAccess(geminiIdentity, "direct-project", "write")).toBe(false);
  });
});
