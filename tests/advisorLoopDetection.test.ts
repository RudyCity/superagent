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

  it("warns when reading the same file 3 times without any edits", () => {
    const readCall: ToolCall[] = [
      { id: "1", name: "read", args: { filePath: "src/core/agent.ts", limit: 100 } },
    ];
    const readResult: ToolResult[] = [
      { toolCallId: "1", name: "read", result: "file content 1" },
    ];

    expect(advisor.evaluateStep(readCall, readResult).action).toBe("pass");
    const readCall2: ToolCall[] = [
      { id: "2", name: "read", args: { filePath: "src/core/agent.ts", limit: 200 } },
    ];
    const readResult2: ToolResult[] = [
      { toolCallId: "2", name: "read", result: "file content 2" },
    ];
    expect(advisor.evaluateStep(readCall2, readResult2).action).toBe("pass");

    const readCall3: ToolCall[] = [
      { id: "3", name: "read", args: { filePath: "src/core/agent.ts", limit: 300 } },
    ];
    const readResult3: ToolResult[] = [
      { toolCallId: "3", name: "read", result: "file content 3" },
    ];
    const res3 = advisor.evaluateStep(readCall3, readResult3);
    expect(res3.action).toBe("warn_agent");
    expect(res3.message).toContain("read 'agent.ts' 3 times without making any edits");
  });

  it("pauses execution when reading the same file 5 times without any edits", () => {
    for (let i = 1; i <= 4; i++) {
      const call: ToolCall[] = [
        { id: `${i}`, name: "read", args: { filePath: "src/core/agent.ts", offset: i * 50 } },
      ];
      const result: ToolResult[] = [
        { toolCallId: `${i}`, name: "read", result: `content ${i}` },
      ];
      advisor.evaluateStep(call, result);
    }

    const call5: ToolCall[] = [
      { id: "5", name: "read", args: { filePath: "src/core/agent.ts", offset: 500 } },
    ];
    const result5: ToolResult[] = [
      { toolCallId: "5", name: "read", result: "content 5" },
    ];
    const res5 = advisor.evaluateStep(call5, result5);
    expect(res5.action).toBe("pause_execution");
    expect(res5.message).toContain("unprogressed read loop");
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
  });
});
