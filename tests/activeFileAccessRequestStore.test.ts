import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACTIVE_RULE_REQUESTS_FILENAME,
  createActiveFileAccessRequest,
} from "../src/core/desktopUi/activeFileAccessRequestStore.js";
import {
  dispatchProjectMcpTool,
  PROJECT_MCP_TOOL_CLASSIFICATIONS,
  PROJECT_MCP_TOOL_DEFS,
} from "../src/core/mcp/tools/projectTools.js";
import { PROJECT_REGISTRY_TOOL_NAMES } from "../src/core/mcp/mcpWorkspacePolicy.js";
import { getPermanentFileToolReadiness } from "../src/core/tools/registeredFileToolGate.js";

const identity = { mode: "oauth" as const, subject: "test-oauth-client" };

const temporaryDirectories: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-active-file-request-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent active file access requests", () => {
  it("writes a Tray-compatible pending Allow request without changing the ACL", () => {
    const configDir = tempDir();
    const filePath = path.join(configDir, "selected-image.jpg");
    const result = createActiveFileAccessRequest(identity, {
      filePath,
      operations: ["read"],
      reason: "Read this selected image for an authenticated browser upload.",
    }, {
      configDir,
      now: () => 1_800_000_000_000,
      id: () => "a".repeat(32),
    });

    expect(result).toMatchObject({
      requestId: "rule_req_" + "a".repeat(32),
      status: "pending",
      kind: "file",
      effect: "allow",
      filePath,
      recursive: false,
      operations: ["read"],
      duplicate: false,
      grantCreated: false,
    });
    const queuePath = path.join(configDir, ACTIVE_RULE_REQUESTS_FILENAME);
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: result.requestId,
      sourceName: expect.stringMatching(/^MCP Agent [a-f0-9]{12}$/),
      kind: "file",
      effect: "allow",
      targetPath: filePath,
      recursive: false,
      operations: ["read"],
      status: "pending",
      createdAt: 1_800_000_000_000,
    });
    expect(JSON.stringify(queue[0]).includes(identity.subject)).toBe(false);
    expect(fs.existsSync(path.join(configDir, "desktop-access-registry.json"))).toBe(false);
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("deduplicates identical pending requests but keeps different operations separate", () => {
    const configDir = tempDir();
    const input = {
      filePath: path.join(configDir, "upload.jpg"),
      operations: ["read" as const],
      reason: "Read selected media for browser upload.",
    };
    const first = createActiveFileAccessRequest(identity, input, {
      configDir, id: () => "b".repeat(32),
    });
    const duplicate = createActiveFileAccessRequest(identity, input, {
      configDir, id: () => "c".repeat(32),
    });
    expect(duplicate.requestId).toBe(first.requestId);
    expect(duplicate.duplicate).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(configDir, ACTIVE_RULE_REQUESTS_FILENAME), "utf8"))).toHaveLength(1);

    const writeRequest = createActiveFileAccessRequest(identity, {
      ...input,
      operations: ["write"],
      reason: "Write generated output to this selected directory.",
    }, { configDir, id: () => "d".repeat(32) });
    expect(writeRequest.requestId).not.toBe(first.requestId);
    expect(JSON.parse(fs.readFileSync(path.join(configDir, ACTIVE_RULE_REQUESTS_FILENAME), "utf8"))).toHaveLength(2);
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("rejects relative, root, UNC, broad or malformed requests", () => {
    const configDir = tempDir();
    const goodPath = path.join(configDir, "report.pdf");
    expect(() => createActiveFileAccessRequest(identity, {
      filePath: "report.pdf", operations: ["read"], reason: "Read the selected report file.",
    }, { configDir })).toThrow(/absolute/i);
    expect(() => createActiveFileAccessRequest(identity, {
      filePath: process.platform === "win32" ? path.win32.parse(goodPath).root : "/",
      operations: ["read"], reason: "Read the root directory.",
    }, { configDir })).toThrow(/root/i);
    expect(() => createActiveFileAccessRequest(identity, {
      filePath: goodPath, operations: ["execute" as any], reason: "Run something.",
    }, { configDir })).toThrow(/operations/i);
    expect(() => createActiveFileAccessRequest(identity, {
      filePath: goodPath, operations: ["read", "read"], reason: "Duplicate operations.",
    }, { configDir })).toThrow(/operations/i);
    expect(() => createActiveFileAccessRequest(identity, {
      filePath: goodPath, operations: ["read"], reason: "bad\nreason",
    }, { configDir })).toThrow(/reason/i);
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("fails closed on a corrupt queue and leaves it untouched", () => {
    const configDir = tempDir();
    const queuePath = path.join(configDir, ACTIVE_RULE_REQUESTS_FILENAME);
    fs.writeFileSync(queuePath, "{broken", "utf8");
    expect(() => createActiveFileAccessRequest(identity, {
      filePath: path.join(configDir, "upload.jpg"),
      operations: ["read"],
      reason: "Read selected media for browser upload.",
    }, { configDir })).toThrow(/corrupt/i);
    expect(fs.readFileSync(queuePath, "utf8")).toBe("{broken");
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("exposes a safe MCP tool that submits only to the existing active-rules queue", async () => {
    const definition = PROJECT_MCP_TOOL_DEFS.find(tool => tool.name === "superagent_request_file_access");
    expect(definition).toBeDefined();
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_request_file_access).toBe("safe");
    expect(PROJECT_REGISTRY_TOOL_NAMES.has("superagent_request_file_access")).toBe(true);
    expect(getPermanentFileToolReadiness("superagent_request_file_access")).toBe("certified_metadata");

    const configDir = tempDir();
    const previous = process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR = configDir;
    try {
      const filePath = path.join(configDir, "browser-upload.png");
      const result = await dispatchProjectMcpTool("superagent_request_file_access", {
        filePath,
        operations: ["read"],
        reason: "Read the selected image for a browser upload.",
      }, identity);
      const payload = JSON.parse(result.content[0].text);
      expect(payload).toMatchObject({
        status: "pending",
        kind: "file",
        effect: "allow",
        filePath,
        operations: ["read"],
        grantCreated: false,
      });
      expect(JSON.parse(fs.readFileSync(path.join(configDir, ACTIVE_RULE_REQUESTS_FILENAME), "utf8"))).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR = previous;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("requires an authenticated identity and does not accept an agent-supplied source label or effect", async () => {
    const result = await dispatchProjectMcpTool("superagent_request_file_access", {
      filePath: path.join(os.tmpdir(), "upload.png"),
      operations: ["read"],
      reason: "Read the selected image for upload.",
      sourceName: "pretend operator",
      effect: "allow",
    }, null);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/authenticated MCP identity/i);
  });
});
