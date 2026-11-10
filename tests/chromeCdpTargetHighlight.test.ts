import { describe, expect, test } from "vitest";
import {
  buildHighlightTargetJs, buildClearHighlightJs, executeTargetHighlightCommand,
} from "../src/core/tools/chromeCdpTargetHighlight.js";

describe("headed CDP element target highlighting", () => {
  test("builds a non-interactive, scoped marker with a visibility + hit-test gate", () => {
    const script = buildHighlightTargetJs("[data-test='pay']", "agent-alpha");
    expect(script).toContain("__superagent_target_highlight__agent-alpha");
    expect(script).toContain("elementFromPoint");
    expect(script).toContain("TARGET_OCCLUDED");
    expect(script).toContain("TARGET_DISABLED");
    expect(script).toContain("pointerEvents = 'none'");
    expect(script).toContain('querySelector("[data-test=\'pay\']")');
    expect(script).not.toContain("dispatchEvent");
    expect(buildClearHighlightJs("agent-alpha")).not.toContain("agent-beta");
  });

  test("rejects bad selectors before dispatch", async () => {
    let called = 0;
    const send = async () => { called++; return {}; };
    expect(await executeTargetHighlightCommand(send, { id: "t" }, "highlight_target", {}))
      .toContain("requires a CSS selector");
    expect(called).toBe(0);
  });

  test("returns actual CDP evaluation result or explicit failure", async () => {
    const sent: string[] = [];
    const send = async (_target: any, method: string, params: any) => {
      sent.push(params.expression);
      return { result: { value: { ok: true, code: "TARGET_HIGHLIGHTED", tag: "button",
        rect: { x: 8, y: 20, width: 100, height: 30 } } } };
    };
    const result = await executeTargetHighlightCommand(send, { id: "t" }, "highlight_target",
      { selector: "button" }, "agent-alpha");
    expect(JSON.parse(result).tag).toBe("button");
    expect(sent[0]).toContain("button");
    expect((await executeTargetHighlightCommand(send, { id: "t" }, "clear_highlight", {}, "agent-alpha")))
      .toContain("cleared");
    expect(sent[1]).toContain("__superagent_target_highlight__agent-alpha");
  });
});
