/**
 * Isolated PDF MCP tool catalog and dispatcher.
 * The primary SuperAgent MCP server is being edited by a concurrent agent.
 * Register these tools into it only after reviewing that agent's changes.
 * Meanwhile scripts/pdf-mcp.ts exposes a secure opt-in stdio endpoint.
 */
import type { McpToolResult } from "../types.js";
import {
  pdfInspectTool, pdfExtractTool, pdfOcrTool, pdfOcrSearchableTool, pdfRenderTool, pdfEditTool,
  pdfSplitTool, pdfVerifyTool, pdfRedactRasterTool,
  pdfEditVectorExactTool, pdfSignTool, pdfVerifySignatureTool,
} from "../../tools/pdfTools.js";

const pdfNames = [
  pdfInspectTool, pdfExtractTool, pdfOcrTool, pdfOcrSearchableTool, pdfRenderTool, pdfEditTool,
  pdfSplitTool, pdfVerifyTool, pdfRedactRasterTool,
  pdfEditVectorExactTool, pdfSignTool, pdfVerifySignatureTool,
];
const byMcpName = new Map(pdfNames.map(tool => ["superagent_" + tool.name, tool] as const));
export const PDF_MCP_MUTATING_NAMES = new Set([
  "superagent_pdf_render", "superagent_pdf_edit", "superagent_pdf_split", "superagent_pdf_redact_raster",
  "superagent_pdf_edit_vector_exact", "superagent_pdf_sign", "superagent_pdf_ocr_searchable",
]);
export const PDF_MCP_TOOL_DEFS = pdfNames.map(tool => ({
  name: "superagent_" + tool.name,
  description: tool.description,
  inputSchema: {
    ...tool.parameters,
    properties: {
      ...(tool.parameters.properties as Record<string, unknown> | undefined ?? {}),
      projectId: { type: "string", description: "Optional registered project ID; requires the applicable project access capability." },
      workspace: { type: "string", description: "Optional workspace inside the currently authorized local project." },
    },
  },
}));
export const PDF_MCP_TOOL_NAMES = new Set(PDF_MCP_TOOL_DEFS.map(tool => tool.name));
export const PDF_MCP_TOOL_CLASSIFICATIONS = Object.fromEntries(
  PDF_MCP_TOOL_DEFS.map(t => [t.name, PDF_MCP_MUTATING_NAMES.has(t.name) ? "dangerous" : "safe"]),
) as Record<string, "dangerous" | "safe">;

export async function dispatchPdfMcpTool(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
  opts: { allowWrite: boolean; signal?: AbortSignal },
): Promise<McpToolResult> {
  const tool = byMcpName.get(name);
  if (!tool) return {
    content: [{ type: "text", text: JSON.stringify({ status: "failed", code: "tool_not_found" }) }],
    isError: true,
  };
  if (PDF_MCP_MUTATING_NAMES.has(name) && !opts.allowWrite) return {
    content: [{ type: "text", text: JSON.stringify({ status: "failed", code: "write_permission_required", message: "PDF write tools require explicit operator opt-in." }) }],
    isError: true,
  };
  try {
    const raw = await tool.execute(args, workspace, opts.signal);
    let parsed: unknown = raw;
    try { parsed = JSON.parse(raw); } catch { /* malformed content remains an error */ }
    const failed = (typeof parsed === "object" && parsed !== null && "status" in parsed
      && (parsed as { status?: string }).status === "failed");
    return { content: [{ type: "text", text: raw }], ...(failed ? { isError: true } : {}) };
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "failed", code: "pdf_error", message: String((error as Error).message).slice(0, 300) }) }],
      isError: true,
    };
  }
}
