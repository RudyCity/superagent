import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dispatchPdfMcpTool, PDF_MCP_TOOL_DEFS, PDF_MCP_MUTATING_NAMES } from "../src/core/mcp/tools/pdfMcpTools.js";
import { MODIFYING_TOOLS, isSuperagentOutOfBounds } from "../src/core/permissions.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-pdf-mcp-"));
  const doc = await PDFDocument.create();
  doc.addPage([320, 480]);
  await fs.writeFile(path.join(dir, "test.pdf"), await doc.save());
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("PDF MCP security and transport", () => {
  it("marks every output-creating PDF tool as mutating in the normal agent permission layer", () => {
    for (const name of ["pdf_edit", "pdf_split", "pdf_render", "pdf_redact_raster", "pdf_edit_vector_exact", "pdf_sign", "pdf_ocr_searchable"]) {
      expect(MODIFYING_TOOLS).toContain(name);
      expect(PDF_MCP_MUTATING_NAMES).toContain("superagent_" + name);
      expect(isSuperagentOutOfBounds({ name, args: { inputPath: "test.pdf", outputPath: "../outside.pdf" } }, dir)).toBe(true);
    }
  });

  it("rejects PDF mutation when launched without explicit write grant", async () => {
    const blocked = await dispatchPdfMcpTool("superagent_pdf_edit", {
      inputPath: "test.pdf", outputPath: "result.pdf", operations: [{ op: "page_numbers" }],
    }, dir, { allowWrite: false });
    expect(blocked.isError).toBe(true);
    expect(JSON.parse(String(blocked.content[0].text)).code).toBe("write_permission_required");
    await expect(fs.stat(path.join(dir, "result.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    const read = await dispatchPdfMcpTool("superagent_pdf_inspect", { inputPath: "test.pdf" }, dir, { allowWrite: false });
    expect(read.isError).toBeUndefined();
    expect(JSON.parse(String(read.content[0].text)).pageCount).toBe(1);
  });

  it("exposes safe-only tools over real stdio MCP and denies hidden edits", async () => {
    const serverScript = path.resolve(process.cwd(), "scripts/pdf-mcp.ts");
    const client = new Client({ name: "pdf-tool-test", version: "0.1.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: "bun", args: [serverScript], cwd: dir, stderr: "pipe" });
    try {
      await client.connect(transport);
      const list = await client.listTools();
      expect(list.tools.some(tool => tool.name === "superagent_pdf_inspect")).toBe(true);
      expect(list.tools.some(tool => tool.name === "superagent_pdf_edit")).toBe(false);
      const inspected = await client.callTool({ name: "superagent_pdf_inspect", arguments: { inputPath: "test.pdf" } });
      expect(inspected.isError).toBeFalsy();
      const contents = inspected.content as Array<{ type: string; text?: string }>;
      expect(JSON.parse(contents[0].text || "{}").pageCount).toBe(1);
      const denied = await client.callTool({ name: "superagent_pdf_edit", arguments: {
        inputPath: "test.pdf", outputPath: "result.pdf", operations: [{ op: "page_numbers" }],
      } });
      expect(denied.isError).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 20_000);

  it("registers full catalog when explicitly opted-in and executes a PDF edit", async () => {
    const serverScript = path.resolve(process.cwd(), "scripts/pdf-mcp.ts");
    const client = new Client({ name: "pdf-write-test", version: "0.1.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: "bun", args: [serverScript, "--allow-write"], cwd: dir, stderr: "pipe" });
    try {
      await client.connect(transport);
      const defs = (await client.listTools()).tools;
      expect(defs.length).toBe(PDF_MCP_TOOL_DEFS.length);
      const result = await client.callTool({ name: "superagent_pdf_edit", arguments: {
        inputPath: "test.pdf", outputPath: "result.pdf", operations: [{ op: "rotate_pages", pages: [1], degrees: 90 }],
      } });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(payload.status).toBe("verified");
      const saved = await fs.readFile(path.join(dir, "result.pdf"));
      expect(saved.subarray(0, 5).toString()).toBe("%PDF-");
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 20_000);
});
