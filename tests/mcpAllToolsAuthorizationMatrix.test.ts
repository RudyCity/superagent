/**
 * Complete active MCP catalog contract and authorization matrix.
 *
 * Every advertised tool gets independent named tests. These tests intentionally
 * never issue a successful tool operation: no files, network targets, Chrome,
 * device shell, desktop input, or service mutation can be touched.
 *
 * This is source + in-process authorization coverage, NOT live tool execution.
 * Native/device runtime verification is a distinct, attended release gate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSuperagentMcpServer, MCP_TOOL_DEFINITIONS,
} from "../src/core/mcp/superagentMcpServer.js";
import {
  DISABLED_MCP_TOOLS, MCP_TOOL_CLASSIFICATION, PRIVILEGED_MCP_TOOLS,
} from "../src/core/mcp/mcpToolPolicy.js";
import {
  MCP_GATEWAY_TOOL_NAMES,
  describeGatewayTool, getGatewayVisibleCatalog,
  validateGatewayExecuteTarget,
} from "../src/core/mcp/mcpToolGateway.js";
import {
  getPermanentFileToolReadiness, registeredFileToolGate,
} from "../src/core/tools/registeredFileToolGate.js";
import {
  PROJECT_ACCESS_CAPABILITIES, getProjectCapabilityForTool,
} from "../src/core/project/projectAccessPolicy.js";
import {
  PROJECT_REGISTRY_TOOL_NAMES, WORKSPACE_SCOPED_MCP_TOOLS,
} from "../src/core/mcp/mcpWorkspacePolicy.js";

type McpServer = ReturnType<typeof createSuperagentMcpServer>;
type AdvertisedTool = {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  annotations: Record<string, any>;
  _meta: {
    mcpApproval: Record<string, any>;
    securitySchemes: Array<{scopes?: string[]}>;
    filePolicy: { active: boolean; readiness: string; requirement: string; note: string };
  };
};
const all = [...MCP_TOOL_DEFINITIONS];
const active = all.filter(tool => !DISABLED_MCP_TOOLS.has(tool.name));
const gatewayNames = new Set(Object.values(MCP_GATEWAY_TOOL_NAMES));
const riskStates = new Set([
  "certified_metadata", "certified_non_file", "certified_app_storage", "requires_explicit_files",
  "action_dependent", "uncertified",
]);
const capabilities = new Set<string>(PROJECT_ACCESS_CAPABILITIES);
const names = active.map(tool => tool.name);
const dangerous = active.filter(tool => MCP_TOOL_CLASSIFICATION[tool.name] === "dangerous");
const uncertified = active.filter(tool => getPermanentFileToolReadiness(tool.name) === "uncertified");
const workspaceTools = active.filter(tool => WORKSPACE_SCOPED_MCP_TOOLS.has(tool.name));

function call(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  return (server as any)._requestHandlers.get("tools/call")({
    method: "tools/call", params: { name, arguments: args },
  }) as Promise<any>;
}
async function list(server: McpServer): Promise<AdvertisedTool[]> {
  const response = await (server as any)._requestHandlers.get("tools/list")({
    method: "tools/list", params: {},
  });
  return response.tools;
}
function parse(response: any): any {
  return JSON.parse(response.content.find((part: any) => part.type === "text").text);
}
function scopeIdentity(subject: string, scopes: string[]) {
  return { mode: "oauth" as const, subject, scopes };
}

describe("ALL active SuperAgent MCP tools: complete non-executing authorization matrix", () => {
  let root: string;
  let previousConfig: string | undefined;
  let admin: McpServer;
  let reader: McpServer;
  let noScopes: McpServer;
  let adminList: Map<string, AdvertisedTool>;
  let readerNames: Set<string>;
  let noneNames: Set<string>;
  let descriptors: Map<string, any>;

  beforeAll(async () => {
    previousConfig = process.env.SUPERAGENT_CONFIG_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-all-mcp-tools-"));
    process.env.SUPERAGENT_CONFIG_DIR = root;
    fs.writeFileSync(path.join(root, "desktop-access-registry.json"),
      JSON.stringify({ version: 2, defaultEffect: "deny", rules: [] }), "utf8");

    // Distinct OAuth principals with NO project or connection operation grants.
    const create = (subject: string, scopes: string[]) =>
      createSuperagentMcpServer({
        toolExposure: "full", authMode: "oauth",
        getIdentity: () => scopeIdentity(subject, scopes),
        workspace: root, allowDangerous: true,
      });
    admin = create("all-tools-admin-discovery", ["mcp:tools", "mcp:tools:write", "mcp:tools:admin"]);
    reader = create("all-tools-readonly", ["mcp:tools"]);
    noScopes = create("all-tools-no-scopes", []);
    adminList = new Map((await list(admin)).map(t => [t.name, t]));
    readerNames = new Set((await list(reader)).map(t => t.name));
    noneNames = new Set((await list(noScopes)).map(t => t.name));
    descriptors = new Map();

    // Gateway description uses the real MCP handler, but never invokes the target.
    for (const tool of active) {
      if (gatewayNames.has(tool.name)) continue;
      const result = await call(admin, MCP_GATEWAY_TOOL_NAMES.describe, { name: tool.name });
      expect(result.isError, tool.name).not.toBe(true);
      descriptors.set(tool.name, parse(result));
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([admin?.close(), reader?.close(), noScopes?.close()]);
    if (previousConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = previousConfig;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("enforces a 238-tool minimum and exact active admin inventory (no silent omissions)", () => {
    expect(active.length).toBeGreaterThanOrEqual(238);
    expect(new Set(names).size).toBe(active.length);
    expect(adminList.size).toBe(active.length);
    expect([...adminList.keys()].sort()).toEqual([...names].sort());
    expect(noneNames.size).toBe(0);
    for (const disabled of DISABLED_MCP_TOOLS) {
      expect(adminList.has(disabled), disabled).toBe(false);
      expect(readerNames.has(disabled), disabled).toBe(false);
    }
  });

  it("ensures the gateway's dynamic catalog covers every non-router tool", () => {
    const visible = getGatewayVisibleCatalog([...adminList.values()]);
    const expected = active.filter(t => !gatewayNames.has(t.name)).map(t => t.name).sort();
    expect(visible.map(t => t.name).sort()).toEqual(expected);
    for (const tool of active) {
      const target = describeGatewayTool(visible, tool.name);
      expect(Boolean(target), tool.name).toBe(!gatewayNames.has(tool.name));
      const accepted = validateGatewayExecuteTarget(visible, { name: tool.name, arguments: {} });
      expect(Boolean(accepted), tool.name).toBe(!gatewayNames.has(tool.name));
    }
  });

  // EVERY active MCP tool is its own named test: schema, OAuth, classification,
  // project-capability metadata, host readiness, and live gateway description.
  it.each(active.map(tool => [tool.name, tool] as const))(
    "%s: catalog, schema, OAuth visibility, project grant and file-policy contract",
    (name, definition) => {
      const advertised = adminList.get(name);
      expect(advertised, name).toBeDefined();
      expect(advertised!.name).toBe(name);
      expect(advertised!.description?.trim().length, name).toBeGreaterThan(0);
      expect(advertised!.inputSchema, name).toEqual(definition.inputSchema);
      expect(advertised!.inputSchema.type, name).toBe("object");
      expect(advertised!.inputSchema.properties, name).toBeDefined();
      const required = advertised!.inputSchema.required || [];
      expect(Array.isArray(required), name).toBe(true);
      expect(new Set(required).size, name).toBe(required.length);
      for (const key of required) {
        expect(typeof key, name).toBe("string");
        expect(Object.prototype.hasOwnProperty.call(advertised!.inputSchema.properties, key), name).toBe(true);
      }

      const risk = MCP_TOOL_CLASSIFICATION[name];
      expect(["safe", "dangerous"], name).toContain(risk);
      expect(readerNames.has(name), name).toBe(risk === "safe");
      const schemes = advertised!._meta.securitySchemes[0]?.scopes ?? [];
      expect(schemes, name).toContain("mcp:tools");
      if (risk === "dangerous") expect(schemes, name).toContain("mcp:tools:write");
      if (PRIVILEGED_MCP_TOOLS.has(name)) expect(schemes, name).toContain("mcp:tools:admin");
      if (name === MCP_GATEWAY_TOOL_NAMES.execute) {
        expect(advertised!.annotations.readOnlyHint).toBe(false);
        expect(advertised!._meta.mcpApproval.kind).toBe("target_dependent");
      } else {
        expect(advertised!.annotations.readOnlyHint, name).toBe(risk === "safe");
        expect(advertised!.annotations.destructiveHint, name).toBe(risk !== "safe");
      }
      expect(advertised!._meta.filePolicy.active, name).toBe(true);
      expect(riskStates.has(advertised!._meta.filePolicy.readiness), name).toBe(true);
      expect(advertised!._meta.filePolicy.readiness, name)
        .toBe(getPermanentFileToolReadiness(name));
      expect(advertised!._meta.filePolicy.requirement?.length, name).toBeGreaterThan(10);
      expect(advertised!._meta.filePolicy.note, name).toMatch(/not an execution grant/i);

      const approval = advertised!._meta.mcpApproval;
      expect(["read_only", "project", "operator_admin", "target_dependent"], name)
        .toContain(approval.kind);
      if (PRIVILEGED_MCP_TOOLS.has(name)) expect(approval.kind).toBe("operator_admin");
      if (WORKSPACE_SCOPED_MCP_TOOLS.has(name) && !PRIVILEGED_MCP_TOOLS.has(name)) {
        expect(approval.kind, name).toBe("project");
        expect(capabilities.has(getProjectCapabilityForTool(name, {})), name).toBe(true);
      }
      if (risk === "dangerous" && !PRIVILEGED_MCP_TOOLS.has(name) &&
          !WORKSPACE_SCOPED_MCP_TOOLS.has(name)) {
        expect(approval.kind, name).toBe("project");
        expect(approval.capability, name).toBe("execute");
      }
      if (!gatewayNames.has(name)) {
        const fromGateway = descriptors.get(name);
        expect(fromGateway?.name, name).toBe(name);
        expect(fromGateway?.inputSchema, name).toEqual(definition.inputSchema);
        expect(fromGateway?.filePolicy, name).toBe(getPermanentFileToolReadiness(name));
        expect(fromGateway?.mcpApproval?.kind, name).toBe(approval.kind);
      } else {
        expect(descriptors.has(name), name).toBe(false);
      }
      if (PROJECT_REGISTRY_TOOL_NAMES.has(name) && PRIVILEGED_MCP_TOOLS.has(name)) {
        expect(approval.requiredOAuthScopes, name)
          .toEqual(["mcp:tools:write", "mcp:tools:admin"]);
      }
    },
  );

  // EVERY tool is actually submitted to the direct MCP dispatcher, but only
  // with an identity that has zero OAuth scopes. This guarantees rejection
  // BEFORE tool dispatch, so CI cannot touch the host or start side effects.
  it.each(names)(
    "%s: direct execution is denied BEFORE dispatch with no OAuth scopes",
    async name => {
      await expect(call(noScopes, name, {}), name).rejects.toThrow(/OAuth mcp:tools/);
    },
  );

  // EVERY dangerous tool is denied both directly and as a nested gateway
  // target to a read-only principal, independently of UI or chat YOLO.
  it.each(dangerous.map(tool => tool.name))(
    "%s: write authorization cannot be bypassed via direct or dynamic gateway",
    async name => {
      await expect(call(reader, name, {}), name).rejects.toThrow(/OAuth mcp:tools:write/);
      const nested = await call(reader, MCP_GATEWAY_TOOL_NAMES.execute,
        { name, arguments: {} });
      expect(nested.isError, name).toBe(true);
      expect(JSON.stringify(nested), name).toMatch(/unavailable|unauthorized|denied/i);
    },
  );

  // Host v2 denies unmediated tools and missing explicit files even if a
  // caller's other permission layers were to approve them. Fake executable
  // identity avoids hashing or inspecting the CI runner's real binary.
  it.each(uncertified.map(tool => tool.name))(
    "%s: uncertified host tool fails closed under registered v2 policy",
    name => {
      const reason = registeredFileToolGate({name,args:{}}, root, {
        registry: () => ({version:2,defaultEffect:"deny",rules:[]}),
        identity: () => ({
          platform: process.platform === "win32" ? "win32" :
            process.platform === "darwin" ? "darwin" : "linux",
          executablePath: path.join(root,"fake-superagent-test-binary"),
          sha256:"a".repeat(64),
        }),
      });
      expect(typeof reason, name).toBe("string");
      expect(reason, name).toMatch(/not certified|denied|restricted|unsupported|blocked/i);
    },
  );

  // Action-dependent grants must not flatten Git status into Git mutation.
  it("keeps Git read actions distinct from Git mutation and arbitrary terminal Execute", () => {
    for (const action of ["status","diff","log"]) {
      expect(getProjectCapabilityForTool("superagent_git_action",{action})).toBe("read");
    }
    for (const action of ["add","commit","restore","clean"]) {
      expect(getProjectCapabilityForTool("superagent_git_action",{action})).toBe("git");
    }
    for (const name of ["superagent_exec_command","superagent_cli_bridge","superagent_office_cli"]) {
      expect(getProjectCapabilityForTool(name)).toBe("execute");
    }
    expect(getProjectCapabilityForTool("superagent_read_files")).toBe("read");
    expect(getProjectCapabilityForTool("superagent_write_files")).toBe("write");
  });

  it("reports explicit coverage totals without claiming physical runtime success", () => {
    expect(names.length).toBe(adminList.size);
    expect(dangerous.length).toBeGreaterThan(0);
    expect(uncertified.length).toBeGreaterThan(0);
    expect(workspaceTools.length).toBeGreaterThan(0);
    console.info("[ALL_MCP_TOOLS_CONTRACT_COVERAGE] "+JSON.stringify({
      registered: all.length,
      active: active.length,
      disabled: all.length-active.length,
      perToolSchemaAndDiscovery: active.length,
      perToolNoScopeDirectDenials: active.length,
      dangerousDirectAndGatewayDenials: dangerous.length,
      uncertifiedHostDenials: uncertified.length,
      uncertifiedToolNames: uncertified.map(tool => tool.name).sort(),
      workspaceCapabilityMetadata: workspaceTools.length,
      verifiedLevel: "in_process_contract_only",
      liveDeviceExecution: false,
    }));
  });
});
