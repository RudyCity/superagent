import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("Tray MCP agent prompt surface", () => {
  it("mounts the prompt card above the MCP owner list with preview and history", () => {
    const html = read("apps/superagent-tray/ui/index.html");
    for (const id of [
      "runtime-mcp-prompt-input",
      "runtime-mcp-prompt-count",
      "runtime-mcp-prompt-template",
      "runtime-mcp-prompt-clear",
      "runtime-mcp-prompt-preview-toggle",
      "runtime-mcp-prompt-preview-body",
      "runtime-mcp-prompt-history-list",
      "runtime-mcp-prompt-history-export",
      "runtime-mcp-prompt-history-export-state",
      "runtime-mcp-prompt-diff-mode",
      "runtime-mcp-prompt-save",
      "runtime-mcp-prompt-feedback",
    ]) {
      expect(html, `missing #${id}`).toContain(`id="${id}"`);
    }
    const panel = html.slice(html.indexOf('id="runtime-remote-panel"'));
    expect(panel.indexOf('id="runtime-mcp-prompt"'))
      .toBeLessThan(panel.indexOf("Independent MCP Owners"));
    expect(html).toContain('maxlength="6000"');
    expect(html).toContain("never grants permissions");
    // The Edit MCP Configuration dialog shows the active prompt besides the
    // tool policy controls it is about to change.
    const dialog = html.slice(html.indexOf('id="runtime-mcp-config-form"'));
    expect(dialog.slice(0, dialog.indexOf("runtime-mcp-config-exposure")))
      .toContain('id="runtime-mcp-config-prompt-body"');
    expect(html).toContain('id="runtime-mcp-config-prompt-state"');
  });

  it("wires preview, history, restore, diff and the per-owner badge", () => {
    const js = read("apps/superagent-tray/ui/runtime.js");
    expect(js).toContain('runtimeInvoke("get_mcp_agent_prompt")');
    expect(js).toContain('runtimeInvoke("set_mcp_agent_prompt", {instructions})');
    expect(js).toContain('runtimeInvoke("preview_mcp_agent_prompt"');
    expect(js).toContain("runtimeMcpPromptOwnerBadge()");
    expect(js).toContain("runtimeRenderMcpPromptHistory(");
    expect(js).toContain("runtimeSetMcpPromptSummary(");
    // The badge is rendered inside the MCP owner card, not a separate panel.
    expect(js).toContain('${service.kind === "mcp" ? runtimeMcpPromptOwnerBadge() : ""}');
    // Restore loads the version into the editor; only an explicit save applies it.
    expect(js).toContain("function runtimeRestoreMcpPromptVersion(");
    expect(js).toContain("Nothing changes for MCP clients until you press Save & apply.");
    expect(js).toContain("input.value = entry.prompt.slice(0, input.maxLength);");
    expect(js).toContain('button.dataset.historyAction = action;');
    // Diff is computed from the stored version text against the live draft.
    expect(js).toContain("function runtimeLineDiff(");
    expect(js).toContain("runtimeLineDiff(entry.prompt, base)");
    expect(js).toContain("function runtimeHydrateMcpConfigPrompt(");
    expect(js).toContain("void runtimeHydrateMcpConfigPrompt();");
    // Versions identical to the active prompt are labelled and cannot be
    // restored onto themselves.
    expect(js).toContain('badge.className = "runtime-mcp-prompt-history-current"');
    expect(js).toContain('badge.textContent = "current"');
    expect(js).toContain('if (action === "restore" && isCurrent)');
    expect(js).toContain('button.disabled = true');
    // Diff can compare against the active saved prompt, not only the draft.
    expect(js).toContain("function runtimeSetMcpPromptDiffTarget(");
    expect(js).toContain('runtimeMcpPromptDiffTarget === "saved" ? runtimeMcpPromptCache.prompt : input.value');
    expect(js).toContain("let runtimeMcpPromptDiffTarget = \"draft\"");
    // History export renders Markdown, copies it, and never leaves a dead end.
    expect(js).toContain("function runtimeMcpPromptMarkdown(");
    expect(js).toContain("function runtimeExportMcpPromptHistory(");
    expect(js).toContain("await window.navigator.clipboard.writeText(markdown)");
    expect(js).toContain("Clipboard unavailable — copy the Markdown from the preview panel.");
  });

  it("keeps the native commands and the loopback preview route aligned", () => {
    const rust = read("apps/superagent-tray/src-tauri/src/main.rs");
    expect(rust).toContain("async fn get_mcp_agent_prompt()");
    expect(rust).toContain("async fn set_mcp_agent_prompt(instructions: String)");
    expect(rust).toContain("async fn preview_mcp_agent_prompt(instructions: String)");
    expect(rust).toContain('"/api/desktop/mcp-agent-prompt/preview"');

    const routes = read("src/serverRoutes.ts");
    expect(routes).toContain('pathname === "/api/desktop/mcp-agent-prompt/preview"');
    expect(routes).toContain("MCP_PROMPT_LOCAL_AUTHENTICATED_ONLY");
    expect(routes).toContain("composeMcpSessionInstructions(draft)");
    // Preview must not persist or reload owners.
    const previewBlock = routes.slice(
      routes.indexOf("if (previewOnly) {"),
      routes.indexOf("const saved = saveMcpAgentPrompt(body.instructions);"),
    );
    expect(previewBlock).not.toContain("saveMcpAgentPrompt(");
    expect(previewBlock).not.toContain("applyMcpAgentPromptToRunningOwners(");
  });
});
