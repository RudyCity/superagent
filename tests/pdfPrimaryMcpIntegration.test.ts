import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import {
  createSuperagentMcpServer, MCP_TOOL_DEFINITIONS,
} from "../src/core/mcp/superagentMcpServer.js";
import { getProjectCapabilityForTool, grantProjectAccess } from "../src/core/project/projectAccessPolicy.js";
import { registerProject, removeProject } from "../src/core/project/projectRegistry.js";
import { MCP_TOOL_CLASSIFICATION, getToolAnnotations } from "../src/core/mcp/mcpToolPolicy.js";
import { WORKSPACE_SCOPED_MCP_TOOLS } from "../src/core/mcp/mcpWorkspacePolicy.js";
import { setYoloMode } from "../src/core/permissions.js";
import { PDF_MCP_TOOL_DEFS, PDF_MCP_TOOL_NAMES } from "../src/core/mcp/tools/pdfMcpTools.js";
import { MASTER_AGENT_SYSTEM_PROMPT, SUPERAGENT_SYSTEM_PROMPT } from "../src/core/prompts.js";

let dir: string;
let original: Uint8Array;
type Mcp = ReturnType<typeof createSuperagentMcpServer>;
type RpcHandler = (request: unknown) => Promise<unknown>;
function handler(server: Mcp, method: string): RpcHandler {
  const internal = server as unknown as { _requestHandlers: Map<string, RpcHandler> };
  const found = internal._requestHandlers.get(method);
  if (!found) throw new Error("Missing handler: " + method);
  return found;
}
const call = (server: Mcp, name: string, args: Record<string, unknown> = {}) =>
  handler(server, "tools/call")({ method: "tools/call", params: { name, arguments: args } }) as Promise<{
    content: Array<{type: string; text: string}>;
    isError?: boolean;
  }>;
const listed = (server: Mcp) =>
  handler(server, "tools/list")({ method: "tools/list", params: {} }) as Promise<{ tools: Array<{ name: string; annotations?: {readOnlyHint?: boolean} }> }>;
function parse(res: {content: Array<{text: string}>}): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}
const identity = (scopes: string[]) => ({ mode: "oauth" as const, subject: "pdf-test-user", scopes });
const editArgs = { inputPath: "input.pdf", outputPath: "result.pdf", operations: [{op: "rotate_pages", pages: [1], degrees: 90}] };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-primary-pdf-"));
  const doc = await PDFDocument.create();
  doc.addPage([240, 320]);
  original = await doc.save();
  await fs.writeFile(path.join(dir, "input.pdf"), original);
  setYoloMode(false);
});
afterEach(async () => {
  setYoloMode(false);
  await fs.rm(dir, { recursive: true, force: true });
});

describe("Primary SuperAgent MCP PDF integration", () => {
  it("registers twelve PDF tools with consistent safe/dangerous project policy", () => {
    const registered = MCP_TOOL_DEFINITIONS.filter(t => PDF_MCP_TOOL_NAMES.has(t.name));
    expect(registered).toHaveLength(12);
    expect(PDF_MCP_TOOL_DEFS).toHaveLength(12);
    for (const entry of registered) {
      expect(WORKSPACE_SCOPED_MCP_TOOLS.has(entry.name)).toBe(true);
      expect(entry.inputSchema.properties).toHaveProperty("projectId");
      expect(entry.inputSchema.properties).toHaveProperty("workspace");
      const write = ["superagent_pdf_edit", "superagent_pdf_split", "superagent_pdf_render", "superagent_pdf_redact_raster",
        "superagent_pdf_edit_vector_exact", "superagent_pdf_sign", "superagent_pdf_ocr_searchable"].includes(entry.name);
      expect(MCP_TOOL_CLASSIFICATION[entry.name]).toBe(write ? "dangerous" : "safe");
      expect(getProjectCapabilityForTool(entry.name)).toBe(write ? "write" : "read");
      expect(getToolAnnotations(entry.name)?.readOnlyHint).toBe(!write);
    }
  });

  it("includes capability-aware PDF workflow in Master and Superagent base prompts", () => {
    expect(MASTER_AGENT_SYSTEM_PROMPT).toContain("PDF_WORKFLOW");
    expect(MASTER_AGENT_SYSTEM_PROMPT).toContain("pdf_verify");
    expect(MASTER_AGENT_SYSTEM_PROMPT).toContain("pdf_sign");
    expect(MASTER_AGENT_SYSTEM_PROMPT).toContain("pdf_edit_vector_exact");
    expect(SUPERAGENT_SYSTEM_PROMPT("coder", "feature/pdf", dir)).toContain("pdf_redact_raster");
    expect(SUPERAGENT_SYSTEM_PROMPT("coder", "feature/pdf", dir)).toContain("describe_tool");
  });

  it("lists read-only tools and blocks mutation for OAuth read-only token", async () => {
    const server = createSuperagentMcpServer({
      workspace: dir, toolExposure: "all", authMode: "oauth",
      getIdentity: () => identity(["mcp:tools"]),
    });
    try {
      const names = (await listed(server)).tools.map(t => t.name);
      expect(names).toContain("superagent_pdf_inspect");
      expect(names).toContain("superagent_pdf_ocr");
      expect(names).toContain("superagent_pdf_verify_signature");
      expect(names).not.toContain("superagent_pdf_edit");
      expect(names).not.toContain("superagent_pdf_sign");
      expect(names).not.toContain("superagent_pdf_edit_vector_exact");
      expect(names).not.toContain("superagent_pdf_ocr_searchable");
      const inspected = await call(server, "superagent_pdf_inspect", {inputPath:"input.pdf"});
      expect(inspected.isError).toBeFalsy();
      expect(parse(inspected).pageCount).toBe(1);
      await expect(call(server, "superagent_pdf_edit", editArgs)).rejects.toThrow(/OAuth|scope/);
    } finally {
      await server.close();
    }
  });

  it("denies mutation with YOLO OFF despite OAuth write scope", async () => {
    const server = createSuperagentMcpServer({
      workspace: dir, toolExposure: "all", authMode: "oauth", allowDangerous: true,
      getIdentity: () => identity(["mcp:tools", "mcp:tools:write"]),
    });
    try {
      const names = (await listed(server)).tools.map(t => t.name);
      expect(names).not.toContain("superagent_pdf_edit");
      expect(names).not.toContain("superagent_pdf_sign");
      expect(names).not.toContain("superagent_pdf_edit_vector_exact");
      await expect(call(server, "superagent_pdf_edit", editArgs)).rejects.toThrow(/YOLO OFF/);
      await expect(call(server, "superagent_pdf_sign", {})).rejects.toThrow(/YOLO OFF/);
      await expect(fs.stat(path.join(dir, "result.pdf"))).rejects.toMatchObject({code:"ENOENT"});
    } finally { await server.close(); }
  });

  it("executes editing through primary MCP with scoped YOLO and valid OAuth write scope", async () => {
    setYoloMode(true);
    const server = createSuperagentMcpServer({
      workspace: dir, toolExposure: "all", authMode: "oauth", allowDangerous: true,
      getIdentity: () => identity(["mcp:tools", "mcp:tools:write"]),
    });
    try {
      const names = (await listed(server)).tools.map(t => t.name);
      expect(names).toContain("superagent_pdf_edit");
      const result = await call(server, "superagent_pdf_edit", editArgs);
      expect(result.isError).toBeFalsy();
      expect(parse(result).status).toBe("verified");
      expect(parse(result).outputPath).toContain("result.pdf");
      const inspected = await call(server, "superagent_pdf_inspect", {inputPath:"result.pdf"});
      expect(parse(inspected).pages).toEqual([expect.objectContaining({ rotation: 90 })]);
      expect(Buffer.from(await fs.readFile(path.join(dir,"input.pdf"))).equals(Buffer.from(original))).toBe(true);
    } finally { await server.close(); }
  });

  it("filters gateway search and rechecks OAuth scopes on recursive execution", async () => {
    setYoloMode(true);
    let scopes = ["mcp:tools"];
    const server = createSuperagentMcpServer({
      workspace: dir, toolExposure: "gateway", authMode: "oauth", allowDangerous: true,
      getIdentity: () => identity(scopes),
    });
    try {
      const search = await call(server, "superagent_tool_search", { query: "pdf", limit: 20 });
      const initial = (parse(search).tools as Array<{name:string}>).map(v=>v.name);
      expect(initial).toContain("superagent_pdf_inspect");
      expect(initial).not.toContain("superagent_pdf_edit");
      const denied = await call(server, "superagent_tool_execute", {
        name: "superagent_pdf_edit", arguments: editArgs,
      });
      expect(denied.isError).toBe(true);
      scopes = ["mcp:tools", "mcp:tools:write"];
      const visible = await call(server, "superagent_tool_search", {query:"pdf",limit:20});
      expect((parse(visible).tools as Array<{name:string}>).map(v=>v.name)).toContain("superagent_pdf_edit");
      const executed = await call(server, "superagent_tool_execute", {
        name:"superagent_pdf_edit",arguments:editArgs,
      });
      expect(executed.isError).toBeFalsy();
      expect(parse(executed).status).toBe("verified");
      scopes = ["mcp:tools"];
      const revoked = await call(server, "superagent_tool_search", {query:"pdf",limit:20});
      expect((parse(revoked).tools as Array<{name:string}>).map(v=>v.name)).not.toContain("superagent_pdf_edit");
    } finally { await server.close(); }
  });

  it("enforces separate project read and write grants for PDF operations", async () => {
    setYoloMode(true);
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-other-project-"));
    const projectId = "pdf-access-" + path.basename(other).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-25);
    const user = identity(["mcp:tools", "mcp:tools:write"]);
    // Scoped YOLO intentionally allows one parent above the workspace. Nest
    // this anchor so the separate temp project is genuinely outside that scope.
    const anchor = path.join(dir, "nested", "session");
    await fs.mkdir(anchor, { recursive: true });
    const external = await PDFDocument.create();
    external.addPage([200, 200]);
    await fs.writeFile(path.join(other, "foreign.pdf"), await external.save());
    registerProject({ id: projectId, name: "PDF External Access Fixture", type: "local", root: other });
    const server = createSuperagentMcpServer({
      workspace: anchor, toolExposure: "all", authMode: "oauth", allowDangerous: true,
      getIdentity: () => user,
    });
    try {
      const target = {projectId, inputPath:"foreign.pdf"};
      const denied = await call(server, "superagent_pdf_inspect", target);
      expect(denied.isError).toBe(true);
      grantProjectAccess(user, projectId, ["read"]);
      const allowed = await call(server, "superagent_pdf_inspect", target);
      expect(allowed.isError).toBeFalsy();
      expect(parse(allowed).pageCount).toBe(1);
      const attempt = await call(server, "superagent_pdf_edit", {
        ...target, outputPath:"unapproved.pdf",operations:[{op:"page_numbers"}],
      });
      expect(attempt.isError).toBe(true);
      await expect(fs.stat(path.join(other, "unapproved.pdf"))).rejects.toMatchObject({code:"ENOENT"});
      grantProjectAccess(user, projectId, ["read", "write"]);
      const saved = await call(server, "superagent_pdf_edit", {
        ...target, outputPath:"approved.pdf",operations:[{op:"rotate_pages",pages:[1],degrees:90}],
      });
      expect(saved.isError).toBeFalsy();
      expect(parse(saved).status).toBe("verified");
      expect((await fs.readFile(path.join(other,"approved.pdf"))).subarray(0,5).toString()).toBe("%PDF-");
      const escape = await call(server, "superagent_pdf_inspect", {projectId,inputPath:"../foreign.pdf"});
      expect(escape.isError).toBe(true);
    } finally {
      await server.close();
      removeProject(projectId);
      await fs.rm(other,{recursive:true,force:true});
    }
  });
});
