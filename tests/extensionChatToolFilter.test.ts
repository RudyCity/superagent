import { describe, test, expect } from "vitest";
import {
  chromeExtensionToolset,
  masterToolset,
  superagentToolset,
  EXTENSION_CHAT_HIDDEN_TOOL_NAMES,
  filterExtensionChatTools,
  withModeAwareDiscoveryTools,
} from "../src/core/tools/toolsets.js";

const EXPECTED_HIDDEN = [
  "get_active_browser_tabs",
  "control_isolated_cdp",
  "extract_page_content_markdown",
  "capture_tab_fullpage_pdf",
  "manage_chrome_history",
  "get_browser_console_logs",
  "get_browser_network_logs",
  "manage_browser_cookies_storage",
  "set_browser_emulation",
  "set_network_conditions",
  "run_headless_browser",
  "simulate_virtual_cursor",
];

describe("extension-chat tool filter", () => {
  test("hidden set contains exactly the 12 extension-dependent tools", () => {
    expect([...EXTENSION_CHAT_HIDDEN_TOOL_NAMES].sort()).toEqual(
      [...EXPECTED_HIDDEN].sort()
    );
  });

  test("filter removes the 12 from a toolset", () => {
    const filtered = filterExtensionChatTools(chromeExtensionToolset);
    const names = filtered.map((t) => t.name);
    for (const n of EXPECTED_HIDDEN) expect(names).not.toContain(n);
  });

  test("filter keeps the extension-free browser path and core tools", () => {
    const names = filterExtensionChatTools(chromeExtensionToolset).map((t) => t.name);
    expect(names).toContain("control_chrome_cdp");
    expect(names).toContain("chrome_extension_status");
    expect(names).toContain("list_running_chrome");
  });

  test("filter does not mutate the input array", () => {
    const before = chromeExtensionToolset.map((t) => t.name);
    filterExtensionChatTools(chromeExtensionToolset);
    expect(chromeExtensionToolset.map((t) => t.name)).toEqual(before);
  });

  // --- Inverted logic (user correction 2026-10-08): the 12 are ACTIVE only in
  // chrome-extension chat mode, hidden in every other mode. ---

  test("extension-chat mode keeps all 12 active (chromeExtensionToolset unfiltered)", () => {
    const names = chromeExtensionToolset.map((t) => t.name);
    for (const n of EXPECTED_HIDDEN) expect(names).toContain(n);
  });

  test("other modes hide the 12 (filtered superagent/master toolsets exclude them)", () => {
    for (const ts of [superagentToolset, masterToolset]) {
      const names = filterExtensionChatTools(ts).map((t) => t.name);
      for (const n of EXPECTED_HIDDEN) expect(names).not.toContain(n);
    }
  });

  test("control_chrome_cdp is never filtered in any mode", () => {
    expect(EXTENSION_CHAT_HIDDEN_TOOL_NAMES.has("control_chrome_cdp")).toBe(false);
    for (const ts of [chromeExtensionToolset, superagentToolset, masterToolset]) {
      const before = ts.map((t) => t.name);
      const after = filterExtensionChatTools(ts).map((t) => t.name);
      if (before.includes("control_chrome_cdp")) {
        expect(after).toContain("control_chrome_cdp");
      }
    }
    expect(chromeExtensionToolset.map((t) => t.name)).toContain("control_chrome_cdp");
  });
});
describe("mode-aware list_tools / describe_tool", () => {
  const getWrapped = (name: string, isExt: boolean) => {
    // mirror createAgentForMode(): non-extension modes filter the 12 first.
    // (the 12 live in chromeExtensionToolset; superagent/master never had them)
    const base = isExt ? chromeExtensionToolset : filterExtensionChatTools(chromeExtensionToolset);
    const wrapped = withModeAwareDiscoveryTools(base, isExt);
    const t = wrapped.find((x) => x.name === name);
    if (!t) throw new Error(`wrapped tool ${name} missing`);
    return t;
  };

  test("list_tools hides the 12 in non-extension mode", async () => {
    const out = await getWrapped("list_tools", false).execute({}, "");
    for (const n of EXPECTED_HIDDEN) expect(out).not.toContain(`- ${n}:`);
    expect(out).toContain("- control_chrome_cdp:");
    expect(out).toContain("- list_tools:");
    expect(out).toContain("- describe_tool:");
  });

  test("describe_tool reports hidden tools as unavailable in non-extension mode", async () => {
    const out = await getWrapped("describe_tool", false).execute(
      { tool: "get_active_browser_tabs" },
      ""
    );
    const parsed = JSON.parse(out);
    expect(parsed[0].error).toContain("not available in this mode");
    expect(parsed[0].error).toContain("control_chrome_cdp");
  });

  test("describe_tool still describes visible tools in non-extension mode", async () => {
    const out = await getWrapped("describe_tool", false).execute({ tool: "control_chrome_cdp" }, "");
    const parsed = JSON.parse(out);
    expect(parsed[0].error).toBeUndefined();
    expect(parsed[0].name).toBe("control_chrome_cdp");
    expect(parsed[0].description).toBeTruthy();
  });

  test("describe_tool unknown name still says unknown in non-extension mode", async () => {
    const out = await getWrapped("describe_tool", false).execute({ tool: "no_such_tool_xyz" }, "");
    const parsed = JSON.parse(out);
    expect(parsed[0].error).toContain("Unknown tool");
  });

  test("extension-mode wrapper keeps the 12 listed and describable", async () => {
    const out = await getWrapped("list_tools", true).execute({}, "");
    for (const n of EXPECTED_HIDDEN) expect(out).toContain(`- ${n}:`);
    const dout = await getWrapped("describe_tool", true).execute(
      { tool: "get_active_browser_tabs" },
      ""
    );
    const parsed = JSON.parse(dout);
    expect(parsed[0].error).toBeUndefined();
    expect(parsed[0].description).toBeTruthy();
  });

  test("wrapper does not mutate the input toolset", () => {
    const before = chromeExtensionToolset.map((t) => t.name);
    withModeAwareDiscoveryTools(filterExtensionChatTools(chromeExtensionToolset), false);
    expect(chromeExtensionToolset.map((t) => t.name)).toEqual(before);
  });

  test("wrapper keeps exactly one list_tools and describe_tool", () => {
    const wrapped = withModeAwareDiscoveryTools(filterExtensionChatTools(chromeExtensionToolset), false);
    const names = wrapped.map((t) => t.name);
    expect(names.filter((n) => n === "list_tools")).toHaveLength(1);
    expect(names.filter((n) => n === "describe_tool")).toHaveLength(1);
  });
});
