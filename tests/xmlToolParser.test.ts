import { describe, it, expect } from "vitest";
import { parseXmlToolCalls, StreamXmlFilter } from "../src/utils/xmlToolParser.js";

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

  it("should parse and repair JSON payloads with unescaped double quotes inside values", () => {
    const text = `
<tool_call>
{"name": "run_command", "arguments": {"command": "rm -f tests/temp-* && echo "Done: $(ls tests/temp-* 2>/dev/null | wc -l) files remaining"", "timeout": 10000}}
</tool_call>
`;
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("run_command");
    expect(result.toolCalls[0].args).toEqual({
      command: 'rm -f tests/temp-* && echo "Done: $(ls tests/temp-* 2>/dev/null | wc -l) files remaining"',
      timeout: 10000,
    });
  });

  it("should parse JSON arrays and objects inside XML parameter/element values", () => {
    const text = `
<ask_question>
  <question>What is your choice?</question>
  <options>["Option 1", "Option 2"]</options>
</ask_question>
`;
    const result = parseXmlToolCalls(text, toolDefs);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].args).toEqual({
      question: "What is your choice?",
      options: ["Option 1", "Option 2"],
    });
  });

  it("should parse tool_call blocks containing XML-like tags (fallback)", () => {
    const text = `
<tool_calls>
<tool_call>
<tool_name>bash</tool_name>
<command>cd "D:\\project" && npx tsc</command>
<timeout>30000</timeout>
</tool_call>
</tool_calls>
`;
    const result = parseXmlToolCalls(text, [{ name: "bash" }]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("bash");
    expect(result.toolCalls[0].args).toEqual({
      command: 'cd "D:\\project" && npx tsc',
      timeout: 30000,
    });
  });

  describe("StreamXmlFilter", () => {
    it("should filter out tool calls from stream and emit normal text", () => {
      let output = "";
      const filter = new StreamXmlFilter((text) => {
        output += text;
      }, toolDefs);

      filter.push("Hello ");
      filter.push("world! <tool_calls><tool_call>");
      filter.push('{"name": "run_command", "arguments": {"CommandLine": "npm test"}}');
      filter.push("</tool_call></tool_calls> and then some more text.");
      filter.flush();

      expect(output).toBe("Hello world!  and then some more text.");
    });

    it("should filter out tool calls with mismatched closing tags during streaming", () => {
      let output = "";
      const filter = new StreamXmlFilter((text) => {
        output += text;
      }, toolDefs);

      filter.push("Hello ");
      filter.push("world! <tool_calls><tool_call>");
      filter.push('{"name": "run_command", "arguments": {"CommandLine": "npm test"}}');
      filter.push("</tool_calls></tool_calls> and then some more text.");
      filter.flush();

      expect(output).toBe("Hello world!  and then some more text.");
    });

    it("should flush remaining buffer on flush() if tool call was cut off", () => {
      let output = "";
      const filter = new StreamXmlFilter((text) => {
        output += text;
      }, toolDefs);

      filter.push("Start: <tool_call>{\"name\": ");
      filter.flush();

      expect(output).toBe("Start: <tool_call>{\"name\": ");
    });

    it("should not filter normal text containing < character if it is not a tool tag", () => {
      let output = "";
      const filter = new StreamXmlFilter((text) => {
        output += text;
      }, toolDefs);

      filter.push("If x < 5 then ");
      filter.push("print hello.");
      filter.flush();

      expect(output).toBe("If x < 5 then print hello.");
    });

    it("should filter out DSML tool calls with full-width or standard pipes", () => {
      let output = "";
      const filter = new StreamXmlFilter((text) => {
        output += text;
      }, toolDefs);

      filter.push("Before <｜｜DSML｜｜invoke name=\"run_command\">");
      filter.push("<｜｜DSML｜｜parameter name=\"CommandLine\">npm test</｜｜DSML｜｜parameter>");
      filter.push("</｜｜DSML｜｜invoke> After");
      filter.flush();

      expect(output).toBe("Before  After");
    });
  });

  describe("DSML tool calls parsing", () => {
    it("should parse DSML tool calls with full-width pipes correctly", () => {
      const text = `
<tool_calls>
<｜｜DSML｜｜invoke name="run_command">
<｜｜DSML｜｜parameter name="CommandLine" string="true">npm test</｜｜DSML｜｜parameter>
<｜｜DSML｜｜parameter name="Cwd" string="true">/workspace</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>
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

    it("should parse DSML tool calls with single full-width pipes correctly", () => {
      const text = `
<｜DSML｜tool_calls>
<｜DSML｜invoke name="run_command">
<｜DSML｜parameter name="CommandLine" string="true">npm test</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
`;
      const result = parseXmlToolCalls(text, toolDefs);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("run_command");
      expect(result.toolCalls[0].args).toEqual({
        CommandLine: "npm test",
      });
    });

    it("should respect string='true' attribute in parameters to bypass number conversion", () => {
      const text = `
<invoke name="run_command">
  <parameter name="CommandLine" string="true">12345</parameter>
  <parameter name="WaitMsBeforeAsync" string="false">5000</parameter>
</invoke>
`;
      const result = parseXmlToolCalls(text, toolDefs);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].args).toEqual({
        CommandLine: "12345",
        WaitMsBeforeAsync: 5000,
      });
    });
  });

  describe("Robust parsing fallbacks", () => {
    it("should parse tool_calls blocks with mismatched closing tags (e.g. tool_call closed by tool_calls)", () => {
      const text = `
[SYS] Scanning memory for user context on "Rudy"...

<tool_calls>
<tool_call>
{"name": "view_file", "arguments": {"AbsolutePath": "/test.txt"}}
</tool_calls>
</tool_calls>
`;
      const result = parseXmlToolCalls(text, toolDefs);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("view_file");
      expect(result.toolCalls[0].args).toEqual({ AbsolutePath: "/test.txt" });
      expect(result.cleanText).toBe('[SYS] Scanning memory for user context on "Rudy"...');
    });

    it("should parse tool_calls blocks where tool_call tag is omitted entirely (direct JSON in tool_calls)", () => {
      const text = `
<tool_calls>
{"name": "run_command", "arguments": {"CommandLine": "npm run build"}}
</tool_calls>
`;
      const result = parseXmlToolCalls(text, toolDefs);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("run_command");
      expect(result.toolCalls[0].args).toEqual({ CommandLine: "npm run build" });
      expect(result.cleanText).toBe("");
    });

    it("should clean up stray/leftover XML tool tags from the cleaned text content", () => {
      const text = `
Some intro text.
</tool_calls>
Stray closing tag in the middle.
<tool_call>
{"name": "view_file", "arguments": {"AbsolutePath": "/test.txt"}}
</tool_calls>
Some outro text.
`;
      const result = parseXmlToolCalls(text, toolDefs);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("view_file");
      expect(result.cleanText).toBe("Some intro text.\n\nStray closing tag in the middle.\n\nSome outro text.");
    });

    it("should parse malformed <tool name=...> and <tool_name=...> calls inside mismatched tags", () => {
      const text = `[SYS] Intro text.
<tool_calls>
 │    <tool name="ask_question", "arguments": {"question": "Program Google Colab?", "options": [{"label": "A"}, {"label": "B"}], "isMultiSelect": false}}
 │    <tool_name="view_file", "arguments": {"AbsolutePath": "/test1.txt"}}
 │    <tool_name="view_file", "arguments": {"AbsolutePath": "/test2.txt"}}
 │    </tool_call>`;

      const result = parseXmlToolCalls(text, toolDefs);
      expect(result.toolCalls).toHaveLength(3);
      
      expect(result.toolCalls[0].name).toBe("ask_question");
      expect(result.toolCalls[0].args).toEqual({
        question: "Program Google Colab?",
        options: [{ label: "A" }, { label: "B" }],
        isMultiSelect: false,
      });

      expect(result.toolCalls[1].name).toBe("view_file");
      expect(result.toolCalls[1].args).toEqual({
        AbsolutePath: "/test1.txt",
      });

      expect(result.toolCalls[2].name).toBe("view_file");
      expect(result.toolCalls[2].args).toEqual({
        AbsolutePath: "/test2.txt",
      });

      expect(result.cleanText).toBe("[SYS] Intro text.");
    });
  });

  describe("StreamXmlFilter malformed handling", () => {
    it("should filter out malformed tool calls from stream and emit normal text", () => {
      let output = "";
      const filter = new StreamXmlFilter((text) => {
        output += text;
      }, toolDefs);

      filter.push("Before ");
      filter.push('<tool_calls>\n');
      filter.push(' │    <tool name="ask_question", "arguments": {"question": "Program Google Colab?", "options": [{"label": "A"}], "isMultiSelect": false}}\n');
      filter.push(' │    <tool_name="view_file", "arguments": {"AbsolutePath": "/test1.txt"}}\n');
      filter.push(' │    </tool_call> After');
      filter.flush();

      expect(output.replace(/\s+/g, " ").trim()).toBe("Before After");
    });

    it("should filter out standalone streamed malformed tool calls", () => {
      let output = "";
      const filter = new StreamXmlFilter((text) => {
        output += text;
      }, toolDefs);

      filter.push("Before ");
      filter.push('<tool name="ask_question", "arguments": {"question": "Program Google Colab?", "options": [{"label": "A"}], "isMultiSelect": false}}');
      filter.push(" Middle ");
      filter.push('<tool_name="view_file", "arguments": {"AbsolutePath": "/test1.txt"}}');
      filter.push(" After");
      filter.flush();

      expect(output.replace(/\s+/g, " ").trim()).toBe("Before Middle After");
    });
  });
});


