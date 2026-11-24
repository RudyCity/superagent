import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACTIVE_RULE_REQUESTS_FILENAME,
  createActiveApplicationAccessRequest,
  createActiveFileAccessRequest,
} from "../src/core/desktopUi/activeFileAccessRequestStore.js";
import {
  dispatchProjectMcpTool,
  PROJECT_MCP_TOOL_CLASSIFICATIONS,
  PROJECT_MCP_TOOL_DEFS,
} from "../src/core/mcp/tools/projectTools.js";
import { PROJECT_REGISTRY_TOOL_NAMES } from "../src/core/mcp/mcpWorkspacePolicy.js";
import { isR1OwnerToolCallAllowed } from "../src/core/mcp/mcpSafeOwnerPolicy.js";
import { getPermanentFileToolReadiness } from "../src/core/tools/registeredFileToolGate.js";

const identity = { mode: "oauth" as const, subject: "test-oauth-client" };
const temporaryDirectories: string[] = [];
const originalConfigDir = process.env.SUPERAGENT_CONFIG_DIR;

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-active-rule-request-"));
  temporaryDirectories.push(dir);
  return dir;
}
function queueAt(configDir: string): any[] {
  return JSON.parse(fs.readFileSync(path.join(configDir, ACTIVE_RULE_REQUESTS_FILENAME), "utf8"));
}

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = originalConfigDir;
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("shared Active Rules access requests", () => {
  it("queues file and application requests in the same Tray-compatible store without granting either", () => {
    const configDir = tempDir();
    const filePath = path.join(configDir, "selected-image.png");
    const executablePath = path.join(configDir, "browser.exe");

    const fileRequest = createActiveFileAccessRequest(identity, {
      filePath, operations: ["read"], reason: "Read the selected image for a browser upload.",
    }, { configDir, id: () => "a".repeat(32), now: () => 1_800_000_000_000 });
    const appRequest = createActiveApplicationAccessRequest(identity, {
      executablePath, operations: ["view"], reason: "Allow the browser window to be inspected.",
    }, { configDir, id: () => "b".repeat(32), now: () => 1_800_000_000_001 });

    expect(fileRequest).toMatchObject({
      status: "pending", kind: "file", effect: "allow", filePath,
      operations: ["read"], recursive: false, duplicate: false, grantCreated: false,
    });
    expect(appRequest).toMatchObject({
      status: "pending", kind: "desktop", effect: "allow", executablePath,
      operations: ["view"], duplicate: false, grantCreated: false,
    });

    const queue = queueAt(configDir);
    expect(queue).toHaveLength(2);
    expect(queue[0]).toMatchObject({
      id: appRequest.requestId, kind: "desktop", effect: "allow", targetPath: executablePath,
      recursive: false, operations: ["view"], status: "pending", createdAt: 1_800_000_000_001,
    });
    expect(queue[1]).toMatchObject({
      id: fileRequest.requestId, kind: "file", effect: "allow", targetPath: filePath,
      recursive: false, operations: ["read"], status: "pending", createdAt: 1_800_000_000_000,
    });
    expect(queue.every(item => item.grantCreated === undefined)).toBe(true);
    expect(JSON.stringify(queue)).not.toContain(identity.subject);
    expect(fs.existsSync(path.join(configDir, "desktop-access-registry.json"))).toBe(false);
  });

  it("deduplicates identical pending app requests per identity and separates operations", () => {
    const configDir = tempDir();
    const input: Parameters<typeof createActiveApplicationAccessRequest>[1] = {
      executablePath: path.join(configDir, "editor.exe"),
      operations: ["view"],
      reason: "Inspect the editor window during this task.",
    };
    const first = createActiveApplicationAccessRequest(identity, input, {
      configDir, id: () => "c".repeat(32),
    });
    const duplicate = createActiveApplicationAccessRequest(identity, input, {
      configDir, id: () => "d".repeat(32),
    });
    expect(duplicate.requestId).toBe(first.requestId);
    expect(duplicate.duplicate).toBe(true);
    expect(queueAt(configDir)).toHaveLength(1);

    const otherIdentity = { mode: "oauth" as const, subject: "another-oauth-client" };
    const otherPrincipalRequest = createActiveApplicationAccessRequest(otherIdentity, input, {
      configDir, id: () => "f".repeat(32),
    });
    expect(otherPrincipalRequest.requestId).not.toBe(first.requestId);
    expect(otherPrincipalRequest.sourceName).not.toBe(first.sourceName);
    expect(queueAt(configDir)).toHaveLength(2);

    const inputRequest = createActiveApplicationAccessRequest(identity, {
      ...input, operations: ["input"], reason: "Allow semantic input for an approved editor action.",
    }, { configDir, id: () => "e".repeat(32) });
    expect(inputRequest.requestId).not.toBe(first.requestId);
    expect(queueAt(configDir)).toHaveLength(3);
  });

  it("rejects malformed application paths, scopes, and extra fields", () => {
    const configDir = tempDir();
    const goodPath = path.join(configDir, "app.exe");
    expect(() => createActiveApplicationAccessRequest(identity, {
      executablePath: "app.exe", operations: ["view"], reason: "Inspect this app.",
    }, { configDir })).toThrow(/absolute/i);
    expect(() => createActiveApplicationAccessRequest(identity, {
      executablePath: process.platform === "win32" ? path.win32.parse(goodPath).root : "/",
      operations: ["view"], reason: "Inspect the app root.",
    }, { configDir })).toThrow(/root/i);
    expect(() => createActiveApplicationAccessRequest(identity, {
      executablePath: goodPath, operations: ["launch" as any], reason: "Launch the app.",
    }, { configDir })).toThrow(/operations/i);
    expect(() => createActiveApplicationAccessRequest(identity, {
      executablePath: goodPath, operations: ["view", "view"] as any, reason: "Duplicate app view.",
    }, { configDir })).toThrow(/operations/i);
    expect(() => createActiveApplicationAccessRequest(identity, {
      executablePath: goodPath, operations: ["view"], reason: "Inspect this app.", effect: "allow",
    } as any, { configDir })).toThrow(/Unsupported field/i);
    if (process.platform === "win32") {
      expect(() => createActiveApplicationAccessRequest(identity, {
        executablePath: path.join(configDir, "app.cmd"), operations: ["view"],
        reason: "Inspect this app.",
      }, { configDir })).toThrow(/\.exe/i);
    }
  });

  it("fails closed on a corrupt shared queue without replacing it", () => {
    const configDir = tempDir();
    const queuePath = path.join(configDir, ACTIVE_RULE_REQUESTS_FILENAME);
    fs.writeFileSync(queuePath, "{broken", "utf8");
    expect(() => createActiveApplicationAccessRequest(identity, {
      executablePath: path.join(configDir, "app.exe"), operations: ["view"],
      reason: "Inspect this app window.",
    }, { configDir })).toThrow(/corrupt/i);
    expect(fs.readFileSync(queuePath, "utf8")).toBe("{broken");
  });

  it("registers both request-only MCP tools as safe metadata operations", async () => {
    for (const name of ["superagent_request_file_access", "superagent_request_application_access"]) {
      expect(PROJECT_MCP_TOOL_DEFS.some(tool => tool.name === name)).toBe(true);
      expect(PROJECT_MCP_TOOL_CLASSIFICATIONS[name]).toBe("safe");
      expect(PROJECT_REGISTRY_TOOL_NAMES.has(name)).toBe(true);
      expect(getPermanentFileToolReadiness(name)).toBe("certified_metadata");
    }

    const configDir = tempDir();
    process.env.SUPERAGENT_CONFIG_DIR = configDir;
    const filePath = path.join(configDir, "upload.png");
    const executablePath = path.join(configDir, "browser.exe");

    const fileResult = await dispatchProjectMcpTool("superagent_request_file_access", {
      filePath, operations: ["read"], reason: "Read the selected file for browser upload.",
    }, identity);
    const appResult = await dispatchProjectMcpTool("superagent_request_application_access", {
      executablePath, operations: ["view"], reason: "Inspect the selected browser application.",
    }, identity);
    expect(JSON.parse(fileResult.content[0].text)).toMatchObject({
      status: "pending", kind: "file", grantCreated: false, filePath,
    });
    expect(JSON.parse(appResult.content[0].text)).toMatchObject({
      status: "pending", kind: "desktop", grantCreated: false, executablePath,
    });
    expect(queueAt(configDir)).toHaveLength(2);

    const noIdentity = await dispatchProjectMcpTool("superagent_request_application_access", {
      executablePath, operations: ["view"], reason: "Inspect the selected browser application.",
    }, null);
    expect(noIdentity.isError).toBe(true);
    expect(noIdentity.content[0].text).toMatch(/authenticated MCP identity/i);
  });

  it("keeps SAFE-only requests narrow: exact file read and application view only", () => {
    const root = process.cwd();
    const fileInput = {
      filePath: path.join(os.tmpdir(), "private.txt"),
      operations: ["read"],
      reason: "Read one specifically selected file.",
    };
    expect(isR1OwnerToolCallAllowed("superagent_request_file_access", fileInput, root)).toBe(true);
    expect(isR1OwnerToolCallAllowed("superagent_request_file_access", {
      ...fileInput, operations: ["write"],
    }, root)).toBe(false);
    expect(isR1OwnerToolCallAllowed("superagent_request_file_access", {
      ...fileInput, operations: ["read"], recursive: true,
    }, root)).toBe(false);

    const appInput = {
      executablePath: path.join(os.tmpdir(), "browser.exe"),
      operations: ["view"],
      reason: "Inspect the selected application window.",
    };
    expect(isR1OwnerToolCallAllowed("superagent_request_application_access", appInput, root)).toBe(true);
    expect(isR1OwnerToolCallAllowed("superagent_request_application_access", {
      ...appInput, operations: ["input"],
    }, root)).toBe(false);
    expect(isR1OwnerToolCallAllowed("superagent_request_application_access", {
      ...appInput, operations: ["view", "input"],
    }, root)).toBe(false);
  });
});
