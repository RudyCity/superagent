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

  it("should decode HTML entities in parameter values", () => {
    const text = `
<invoke name="run_command">
  <CommandLine>npm run build &amp;&amp; echo &quot;hello&quot;</CommandLine>
</invoke>
`;
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].args.CommandLine).toBe('npm run build && echo "hello"');
  });

  it("should parse tool_calls blocks with JSON tool_call payloads", () => {
    const text = `
Let me execute these in sequence:
<tool_calls>
<tool_call>
{"name": "glob", "arguments": {"pattern": "src/core/**/*.ts", "limit": 10}}
</tool_call>
<tool_call>
{"name": "run_command", "args": {"command": "node --version"}}
</tool_call>
</tool_calls>
`;
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe("glob");
    expect(result.toolCalls[0].args).toEqual({ pattern: "src/core/**/*.ts", limit: 10 });
    expect(result.toolCalls[1].name).toBe("run_command");
    expect(result.toolCalls[1].args).toEqual({ command: "node --version" });
    expect(result.cleanText).toBe("Let me execute these in sequence:");
  });

  it("should parse standalone tool_call blocks with markdown JSON codeblocks", () => {
    const text = `
<tool_call>
\`\`\`json
{"name": "view_file", "arguments": {"AbsolutePath": "/test.txt"}}
\`\`\`
</tool_call>
`;
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("view_file");
    expect(result.toolCalls[0].args).toEqual({ AbsolutePath: "/test.txt" });
    expect(result.cleanText).toBe("");
  });

  it("should decode HTML entities inside tool_call JSON payloads", () => {
    const text = `
<tool_call>
{"name": "run_command", "arguments": {"command": "npm run build &amp;&amp; echo &quot;hello&quot;"}}
</tool_call>
`;
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].args.command).toBe('npm run build && echo "hello"');
  });
});
