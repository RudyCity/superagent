import { describe, it, expect, beforeEach } from "vitest";
import { RealtimeAdvisor } from "../src/core/advisor.js";
import type { ToolCall, ToolResult } from "../src/core/conversation.js";

describe("RealtimeAdvisor - Loop Detection & Repeated Read Guard", () => {
  let advisor: RealtimeAdvisor;

  beforeEach(() => {
    advisor = new RealtimeAdvisor({
      enableLogging: false,
      enableAdaptiveScaling: false,
      enablePatternMemory: false,
      warningThreshold: 3,
      pauseThreshold: 5,
    });
  });

  it("warns when reading the exact same file chunk 3 times non-consecutively without any edits", () => {
    const chunkCall: ToolCall[] = [
      { id: "1", name: "read", args: { filePath: "src/core/agent.ts", offset: 1, limit: 100 } },
    ];
    const chunkResult: ToolResult[] = [
      { toolCallId: "1", name: "read", result: "file content 1" },
    ];
    const otherCall: ToolCall[] = [
      { id: "other", name: "list_dir", args: { path: "src" } },
    ];
    const otherResult: ToolResult[] = [
      { toolCallId: "other", name: "list_dir", result: "files" },
    ];

    expect(advisor.evaluateStep(chunkCall, chunkResult).action).toBe("pass");
    advisor.evaluateStep(otherCall, otherResult);
    expect(advisor.evaluateStep(chunkCall, chunkResult).action).toBe("pass");
    advisor.evaluateStep(otherCall, otherResult);

    const res3 = advisor.evaluateStep(chunkCall, chunkResult);
    expect(res3.action).toBe("warn_agent");
    expect(res3.message).toContain("read 'agent.ts' (offset 1, limit 100) 3 times without making any edits");
  });

  it("pauses execution when reading the exact same file chunk 5 times non-consecutively without any edits", () => {
    const chunkCall: ToolCall[] = [
      { id: "read", name: "read", args: { filePath: "src/core/agent.ts", offset: 1, limit: 100 } },
    ];
    const chunkResult: ToolResult[] = [
      { toolCallId: "read", name: "read", result: "content" },
    ];
    const otherCall: ToolCall[] = [
      { id: "other", name: "list_dir", args: { path: "src" } },
    ];
    const otherResult: ToolResult[] = [
      { toolCallId: "other", name: "list_dir", result: "files" },
    ];

    for (let i = 1; i <= 4; i++) {
      advisor.evaluateStep(chunkCall, chunkResult);
      advisor.evaluateStep(otherCall, otherResult);
    }

    const res5 = advisor.evaluateStep(chunkCall, chunkResult);
    expect(res5.action).toBe("pause_execution");
    expect(res5.message).toContain("unprogressed read loop: 'agent.ts' (offset 1, limit 100) was read 5 times");
  });

  it("allows reading different chunks/ranges of the same file more than 3 times without warning or pausing (sepotong-sepotong)", () => {
    for (let i = 1; i <= 6; i++) {
      const call: ToolCall[] = [
        { id: `${i}`, name: "read", args: { filePath: "src/core/agent.ts", offset: i * 100, limit: 100 } },
      ];
      const result: ToolResult[] = [
        { toolCallId: `${i}`, name: "read", result: `chunk ${i} content` },
      ];
      const stepRes = advisor.evaluateStep(call, result);
      expect(stepRes.action).toBe("pass");
    }
    expect(advisor.getHealthScore()).toBe(100);
  });

  it("allows reading file in chunks using view_file with StartLine/EndLine ranges without false loop detection", () => {
    const ranges = [
      { start: 1, end: 250 },
      { start: 251, end: 500 },
      { start: 501, end: 750 },
      { start: 751, end: 1000 },
    ];

    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const call: ToolCall[] = [
        { id: `vf-${i}`, name: "view_file", args: { AbsolutePath: "d:/superagent/src/core/agent.ts", StartLine: r.start, EndLine: r.end } },
      ];
      const result: ToolResult[] = [
        { toolCallId: `vf-${i}`, name: "view_file", result: `lines ${r.start}-${r.end}` },
      ];
      const stepRes = advisor.evaluateStep(call, result);
      expect(stepRes.action).toBe("pass");
    }
    expect(advisor.getHealthScore()).toBe(100);
  });

  it("resets repeated read counter when an edit/write tool is executed", () => {
    for (let i = 1; i <= 2; i++) {
      advisor.evaluateStep(
        [{ id: `${i}`, name: "read", args: { filePath: "src/core/agent.ts", offset: i } }],
        [{ toolCallId: `${i}`, name: "read", result: "content" }]
      );
    }

    advisor.evaluateStep(
      [{ id: "edit1", name: "replace_file_content", args: { TargetFile: "src/core/agent.ts" } }],
      [{ toolCallId: "edit1", name: "replace_file_content", result: "Successfully replaced" }]
    );

    const afterEdit1 = advisor.evaluateStep(
      [{ id: "r1", name: "read", args: { filePath: "src/core/agent.ts", offset: 10 } }],
      [{ toolCallId: "r1", name: "read", result: "content" }]
    );
    expect(afterEdit1.action).toBe("pass");

    const afterEdit2 = advisor.evaluateStep(
      [{ id: "r2", name: "read", args: { filePath: "src/core/agent.ts", offset: 20 } }],
      [{ toolCallId: "r2", name: "read", result: "content" }]
    );
    expect(afterEdit2.action).toBe("pass");
  });

  it("detects alternating cycling loops across a sliding window", () => {
    const callA: ToolCall[] = [{ id: "a", name: "list_dir", args: { path: "src" } }];
    const resA: ToolResult[] = [{ toolCallId: "a", name: "list_dir", result: "files" }];

    const callB: ToolCall[] = [{ id: "b", name: "grep_search", args: { query: "foo" } }];
    const resB: ToolResult[] = [{ toolCallId: "b", name: "grep_search", result: "matches" }];

    advisor.evaluateStep(callA, resA);
    advisor.evaluateStep(callB, resB);
    advisor.evaluateStep(callA, resA);
    advisor.evaluateStep(callB, resB);

    const resA3 = advisor.evaluateStep(callA, resA);
    expect(resA3.action).toBe("warn_agent");
    expect(resA3.message).toContain("cycling between repeated tool actions");
    expect(resA3.healthScore).toBeLessThan(100);
  });

  it("does not falsely trigger cycling warning during sequential Chrome page audits", () => {
    const pages = ["posts", "pages", "categories", "orders", "tickets", "settings"];

    for (const page of pages) {
      // Step 1: navigate to page
      const navCall: ToolCall[] = [
        { id: `nav-${page}`, name: "control_chrome_cdp", args: { command: "navigate", url: `http://localhost:7002/admin/cms/${page}` } },
      ];
      const navRes: ToolResult[] = [
        { toolCallId: `nav-${page}`, name: "control_chrome_cdp", result: `navigated tab to http://localhost:7002/admin/cms/${page}` },
      ];
      const navEval = advisor.evaluateStep(navCall, navRes);
      expect(navEval.action).toBe("pass");

      // Step 2: read_page on the newly navigated page
      const readCall: ToolCall[] = [
        { id: `read-${page}`, name: "control_chrome_cdp", args: { command: "read_page" } },
      ];
      const readRes: ToolResult[] = [
        { toolCallId: `read-${page}`, name: "control_chrome_cdp", result: `page content for '${page.toUpperCase()}' (http://localhost:7002/admin/cms/${page})` },
      ];
      const readEval = advisor.evaluateStep(readCall, readRes);
      expect(readEval.action).toBe("pass");
    }

    expect(advisor.getHealthScore()).toBe(100);
  });

  it("detects genuine browser loop when navigating to the exact same page repeatedly with identical content", () => {
    for (let i = 0; i < 2; i++) {
      advisor.evaluateStep(
        [{ id: `nav-${i}`, name: "control_chrome_cdp", args: { command: "navigate", url: "http://localhost:7002/admin/stuck" } }],
        [{ toolCallId: `nav-${i}`, name: "control_chrome_cdp", result: "navigated tab to http://localhost:7002/admin/stuck" }]
      );
      advisor.evaluateStep(
        [{ id: `read-${i}`, name: "control_chrome_cdp", args: { command: "read_page" } }],
        [{ toolCallId: `read-${i}`, name: "control_chrome_cdp", result: "stuck page content" }]
      );
    }

    const thirdNav = advisor.evaluateStep(
      [{ id: "nav-2", name: "control_chrome_cdp", args: { command: "navigate", url: "http://localhost:7002/admin/stuck" } }],
      [{ toolCallId: "nav-2", name: "control_chrome_cdp", result: "navigated tab to http://localhost:7002/admin/stuck" }]
    );

    expect(thirdNav.action).toBe("warn_agent");
    expect(thirdNav.message).toContain("cycling between repeated tool actions");
    expect(thirdNav.suggestion).toContain("browser actions");
    expect(thirdNav.healthScore).toBeLessThan(100);
  });

  it("does not falsely warn when consecutive read_page calls return changing dynamic content", () => {
    const outputs = [
      "Page state: Loading 10%",
      "Page state: Loading 50%",
      "Page state: Loading 90%",
      "Page state: Completed table with 20 items",
    ];

    for (let i = 0; i < outputs.length; i++) {
      const step = advisor.evaluateStep(
        [{ id: `read-${i}`, name: "control_chrome_cdp", args: { command: "read_page" } }],
        [{ toolCallId: `read-${i}`, name: "control_chrome_cdp", result: outputs[i] }]
      );
      expect(step.action).toBe("pass");
    }
  });

  it("provides browser-specific recovery suggestion and auto-correction hint when browser tool repeated without change", () => {
    for (let i = 0; i < 2; i++) {
      advisor.evaluateStep(
        [{ id: `read-${i}`, name: "control_chrome_cdp", args: { command: "read_page" } }],
        [{ toolCallId: `read-${i}`, name: "control_chrome_cdp", result: "identical content" }]
      );
    }

    const third = advisor.evaluateStep(
      [{ id: "read-2", name: "control_chrome_cdp", args: { command: "read_page" } }],
      [{ toolCallId: "read-2", name: "control_chrome_cdp", result: "identical content" }]
    );

    expect(third.action).toBe("warn_agent");
    expect(third.suggestion).toContain("Page content or state has not changed");
    expect(third.autoCorrectionHint).toContain("Browser action warning");
  });
});
