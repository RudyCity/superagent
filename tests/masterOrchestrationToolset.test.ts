/**
 * Regression tests for the Master Agent toolset.
 *
 * AGENTS.md says the Master Agent is orchestration-only and MUST NOT
 * directly modify code or run arbitrary shell. The v1.4.4 security audit
 * (finding C3) identified that several coding tools had leaked into the
 * master toolset. This test pins the curated orchestration-only toolset
 * so a future refactor that re-introduces a coding tool fails CI.
 */
import { describe, it, expect } from "vitest";
import { masterToolset, ORCHESTRATION_TOOL_NAMES } from "../src/core/tools/toolsets.js";

// Tools that MUST NOT appear in the master toolset because they
// execute arbitrary commands or have side effects outside the
// Master's plan/task/walkthrough artifact scope. The Master delegates
// all codebase edits to Superagents (worktree-isolated) and only ever
// writes to `~/.superagent-r/` (which is enforced by the runtime
// path-allowlist in writeToFileTool/replaceFileContentTool.execute
// when tier === "master" — see pathHelpers.enforceMasterWriteAllowlist).
const FORBIDDEN_IN_MASTER: ReadonlySet<string> = new Set([
  "run_command",            // arbitrary shell exec
  "bash",                   // arbitrary shell exec
  "execute_command",        // arbitrary shell exec
  "cross_workspace_exec",   // cross-machine command execution
  "manage_workspace_chain", // adds/removes workspace nodes
  "unlock_file",            // lock-override — only Master should monitor
  "resolve_conflict",       // destructive lock strategy
  "transfer_ssh_file",      // file copy across machines
  "wp",                     // WordPress tool
  "android_cli",            // Android SDK tool
  "playwright_screenshot",  // Browser automation screenshot
  "control_browser_tab",
  "control_browser_macro_save",
  "control_browser_macro_run",
  "launch_chrome_profile",
  "chrome_extension_status",
  "manage_chrome_bookmarks",
  "manage_chrome_history",
  "list_chrome_extensions",
  "get_browser_console_logs",
  "get_browser_network_logs",
  "capture_tab_fullpage_pdf",
  "extract_page_content_markdown",
  "list_chrome_profiles",
  "get_active_browser_tabs",
  // The three write tools (write_to_file, replace_file_content,
  // multi_replace_file_content) are INTENTIONALLY allowed in
  // masterToolset so the Master can write plan/task/walkthrough
  // artifacts, but the runtime path-allowlist blocks writes to
  // codebase paths. They are covered by
  // enforceMasterWriteAllowlist, not by the static toolset.
  // NOTE: office_cli and read_document are read-only inspectors that the
  // audit (C3) explicitly allowed to remain in the master toolset.
]);

describe("Master Agent toolset is orchestration-only", () => {
  it("does not contain any shell-execution or side-effect tools", () => {
    const present = new Set(masterToolset.map((t) => t.name));
    const leaks: string[] = [];
    for (const forbidden of FORBIDDEN_IN_MASTER) {
      if (present.has(forbidden)) leaks.push(forbidden);
    }
    expect(
      leaks,
      `Master toolset leaks these coding tools: ${leaks.join(", ")}`
    ).toEqual([]);
  });

  it("contains the expected orchestration tools", () => {
    const required = new Set([
      "invoke_superagent",
      "await_superagents",
      "merge_superagents",
      "manage_superagents",
      "define_superagent",
      "send_message_to_superagent",
      "manage_subagents",
      "ask_question",
      "read",
      "glob",
      "grep",
      "ripgrep_search",
      "manage_tasks",
      "manage_plan",
      "schedule",
    ]);
    const present = new Set(masterToolset.map((t) => t.name));
    const missing: string[] = [];
    for (const r of required) {
      if (!present.has(r)) missing.push(r);
    }
    expect(
      missing,
      `Master toolset missing required orchestration tools: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("ORCHESTRATION_TOOL_NAMES is in sync with masterToolset", () => {
    const fromArray = new Set(masterToolset.map((t) => t.name));
    expect(ORCHESTRATION_TOOL_NAMES.size).toBe(fromArray.size);
    for (const name of fromArray) {
      expect(
        ORCHESTRATION_TOOL_NAMES.has(name),
        `ORCHESTRATION_TOOL_NAMES missing ${name}`
      ).toBe(true);
    }
  });
});

describe("Subagent read-only toolsets do not include shell", () => {
  it("reviewer does not have bash/run_command", async () => {
    const { subagentToolsets } = await import("../src/core/tools/toolsets.js");
    const reviewer = subagentToolsets.reviewer || [];
    const names = new Set(reviewer.map((t) => t.name));
    expect(names.has("run_command")).toBe(false);
    expect(names.has("bash")).toBe(false);
  });

  it("researcher does not have bash/run_command", async () => {
    const { subagentToolsets } = await import("../src/core/tools/toolsets.js");
    const researcher = subagentToolsets.researcher || [];
    const names = new Set(researcher.map((t) => t.name));
    expect(names.has("run_command")).toBe(false);
    expect(names.has("bash")).toBe(false);
  });

  it("security-engineer does not have bash/run_command", async () => {
    const { subagentToolsets } = await import("../src/core/tools/toolsets.js");
    const sec = subagentToolsets["security-engineer"] || [];
    const names = new Set(sec.map((t) => t.name));
    expect(names.has("run_command")).toBe(false);
    expect(names.has("bash")).toBe(false);
  });
});
