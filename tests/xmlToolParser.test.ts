import { describe, it, expect } from "vitest";
import { parseXmlToolCalls } from "../src/utils/xmlToolParser.js";

describe("xmlToolParser", () => {
  const toolDefs = [
    { name: "ask_question" },
    { name: "run_command" },
    { name: "view_file" },
  ];

  it("should return unchanged text and empty toolCalls when no XML is present", () => {
    const text = "Hello world! This is a simple response without tool calls.";
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanText).toBe(text);
  });

  it("should parse standalone invoke blocks with parameters", () => {
    const text = `
Here is the command you requested:
<invoke name="run_command">
  <parameter name="CommandLine">npm test</parameter>
  <parameter name="Cwd">/workspace</parameter>
</invoke>
Hope this helps!
`;
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("run_command");
    expect(result.toolCalls[0].args).toEqual({
      CommandLine: "npm test",
      Cwd: "/workspace",
    });
    expect(result.cleanText).toBe("Here is the command you requested:\n\nHope this helps!");
  });

  it("should parse invoke blocks wrapped in function_calls", () => {
    const text = `
<function_calls>
  <invoke name="run_command">
    <CommandLine>npm test</CommandLine>
    <Cwd>/workspace</Cwd>
  </invoke>
</function_calls>
`;
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("run_command");
    expect(result.toolCalls[0].args).toEqual({
      CommandLine: "npm test",
      Cwd: "/workspace",
    });
    expect(result.cleanText).toBe("");
  });

  it("should parse direct tag-based tool calls like ask_question", () => {
    const text = `
Some introductory text.
<ask_question>
  <question>Which option do you prefer?</question>
  <options>
    <option>Option A</option>
    <option>Option B</option>
  </options>
  <isMultiSelect>true</isMultiSelect>
</ask_question>
`;
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(1);
    const tc = result.toolCalls[0];
    expect(tc.name).toBe("ask_question");
    expect(tc.args).toEqual({
      question: "Which option do you prefer?",
      options: ["Option A", "Option B"],
      isMultiSelect: true,
    });
    expect(result.cleanText).toBe("Some introductory text.");
  });

  it("should parse primitive values correctly (booleans, numbers, strings)", () => {
    const text = `
<invoke name="run_command">
  <CommandLine>tsc</CommandLine>
  <WaitMsBeforeAsync>5000</WaitMsBeforeAsync>
  <IsTest>false</IsTest>
</invoke>
`;
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].args).toEqual({
      CommandLine: "tsc",
      WaitMsBeforeAsync: 5000,
      IsTest: false,
    });
  });

  it("should ignore XML tags that do not match registered tool names or invoke blocks", () => {
    const text = "We have <some_random_tag>some text</some_random_tag> here.";
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanText).toBe(text);
  });
});
