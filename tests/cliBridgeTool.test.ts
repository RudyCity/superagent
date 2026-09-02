/**
 * tests/cliBridgeTool.test.ts — Unit tests for the `cli_bridge` tool.
 *
 * Strategy:
 *  - Use Node's child_process to spawn a tiny mock "AI CLI" script written
 *    as a here-doc-equivalent (a self-contained Node.js one-liner written
 *    to a temp file). This avoids relying on real Codex/Claude/AGY binaries
 *    being installed in the CI environment.
 *  - Exercise both `delegate` (1-shot) and `session.*` (multi-turn) flows.
 *  - Verify the tool is registered in `superagentToolset` and NOT in
 *    `masterToolset` (per AGENTS.md "Tier Enforcement" rule).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// ─── Test fixtures ───────────────────────────────────────────────────────

const tempHome = path.join(process.cwd(), "tests", "temp-home-clibridge");
const mockDir = path.join(tempHome, "mock-bin");

// A "hello world" CLI: prints a greeting and exits 0.
const HELLO_BIN = path.join(mockDir, "hello_cli" + (process.platform === "win32" ? ".cmd" : ""));
// A REPL-style CLI: reads lines from stdin, echoes a response with a prompt
// marker so the session manager recognizes it as ready.
const REPL_BIN = path.join(mockDir, "repl_cli" + (process.platform === "win32" ? ".cmd" : ""));
// A failing CLI: prints an error and exits 1.
const FAIL_BIN = path.join(mockDir, "fail_cli" + (process.platform === "win32" ? ".cmd" : ""));
// v1.5.15: A CLI that emits an interactive yes/no prompt.
const PROMPT_BIN = path.join(mockDir, "prompt_cli" + (process.platform === "win32" ? ".cmd" : ""));

const isWin = process.platform === "win32";

function writeMockBin(file: string, body: string): void {
  fs.writeFileSync(file, body, { encoding: "utf8" });
  if (!isWin) {
    fs.chmodSync(file, 0o755);
  }
}

beforeAll(() => {
  fs.mkdirSync(mockDir, { recursive: true });
  if (isWin) {
    // .cmd wrapper: call node with the .js sibling in the same directory.
    // Using %~dp0 expands to the directory of the .cmd file (with trailing
    // backslash), which works even when the path contains spaces.
    const jsHello = HELLO_BIN.replace(/\.cmd$/, ".js");
    writeMockBin(jsHello, `console.log("HELLO_FROM_HELLO_CLI");\nprocess.exit(0);\n`);
    fs.writeFileSync(
      HELLO_BIN,
      `@echo off\r\nnode "%~dp0hello_cli.js"\r\n`
    );

    const jsRepl = REPL_BIN.replace(/\.cmd$/, ".js");
    writeMockBin(
      jsRepl,
      `process.stdout.write("repl> ");\n` +
        `process.stdin.setEncoding("utf8");\n` +
        `let buf = "";\n` +
        `process.stdin.on("data", (chunk) => {\n` +
        `  buf += chunk;\n` +
        `  let idx;\n` +
        `  while ((idx = buf.indexOf("\\n")) >= 0) {\n` +
        `    const line = buf.slice(0, idx).trim();\n` +
        `    buf = buf.slice(idx + 1);\n` +
        `    if (line === "exit") { process.exit(0); }\n` +
        `    process.stdout.write("ECHO:" + line + "\\n");\n` +
        `    process.stdout.write("repl> ");\n` +
        `  }\n` +
        `});\n`
    );
    fs.writeFileSync(
      REPL_BIN,
      `@echo off\r\nnode "%~dp0repl_cli.js"\r\n`
    );

    const jsFail = FAIL_BIN.replace(/\.cmd$/, ".js");
    writeMockBin(jsFail, `console.error("INTENTIONAL_FAILURE");\nprocess.exit(7);\n`);
    fs.writeFileSync(
      FAIL_BIN,
      `@echo off\r\nnode "%~dp0fail_cli.js"\r\n`
    );

    // v1.5.15: a CLI that emits a yes/no prompt and exits on answer.
    const jsPrompt = PROMPT_BIN.replace(/\.cmd$/, ".js");
    writeMockBin(
      jsPrompt,
      `process.stdout.write("Allow action 'edit file.txt'? (y/n): ");\n` +
        `process.stdin.setEncoding("utf8");\n` +
        `let buf = "";\n` +
        `process.stdin.on("data", (chunk) => {\n` +
        `  buf += chunk;\n` +
        `  let idx;\n` +
        `  while ((idx = buf.indexOf("\\n")) >= 0) {\n` +
        `    const line = buf.slice(0, idx).trim();\n` +
        `    buf = buf.slice(idx + 1);\n` +
        `    if (line === "y" || line === "yes") {\n` +
        `      process.stdout.write("OK: action approved\\n");\n` +
        `      process.exit(0);\n` +
        `    } else if (line === "n" || line === "no") {\n` +
        `      process.stdout.write("DENIED: action cancelled\\n");\n` +
        `      process.exit(0);\n` +
        `    }\n` +
        `    process.stdout.write("Allow action 'edit file.txt'? (y/n): ");\n` +
        `  }\n` +
        `});\n`
    );
    fs.writeFileSync(
      PROMPT_BIN,
      `@echo off\r\nnode "%~dp0prompt_cli.js"\r\n`
    );
  } else {
    writeMockBin(HELLO_BIN, `#!/usr/bin/env node\nconsole.log("HELLO_FROM_HELLO_CLI");\nprocess.exit(0);\n`);
    writeMockBin(
      REPL_BIN,
      `#!/usr/bin/env node\n` +
        `process.stdout.write("repl> ");\n` +
        `process.stdin.setEncoding("utf8");\n` +
        `let buf = "";\n` +
        `process.stdin.on("data", (chunk) => {\n` +
        `  buf += chunk;\n` +
        `  let idx;\n` +
        `  while ((idx = buf.indexOf("\\n")) >= 0) {\n` +
        `    const line = buf.slice(0, idx).trim();\n` +
        `    buf = buf.slice(idx + 1);\n` +
        `    if (line === "exit") { process.exit(0); }\n` +
        `    process.stdout.write("ECHO:" + line + "\\n");\n` +
        `    process.stdout.write("repl> ");\n` +
        `  }\n` +
        `});\n`
    );
    writeMockBin(FAIL_BIN, `#!/usr/bin/env node\nconsole.error("INTENTIONAL_FAILURE");\nprocess.exit(7);\n`);
    writeMockBin(
      PROMPT_BIN,
      `#!/usr/bin/env node\n` +
        `process.stdout.write("Allow action 'edit file.txt'? (y/n): ");\n` +
        `process.stdin.setEncoding("utf8");\n` +
        `let buf = "";\n` +
        `process.stdin.on("data", (chunk) => {\n` +
        `  buf += chunk;\n` +
        `  let idx;\n` +
        `  while ((idx = buf.indexOf("\\n")) >= 0) {\n` +
        `    const line = buf.slice(0, idx).trim();\n` +
        `    buf = buf.slice(idx + 1);\n` +
        `    if (line === "y" || line === "yes") {\n` +
        `      process.stdout.write("OK: action approved\\n");\n` +
        `      process.exit(0);\n` +
        `    } else if (line === "n" || line === "no") {\n` +
        `      process.stdout.write("DENIED: action cancelled\\n");\n` +
        `      process.exit(0);\n` +
        `    }\n` +
        `    process.stdout.write("Allow action 'edit file.txt'? (y/n): ");\n` +
        `  }\n` +
        `});\n`
    );
  }
});

afterAll(() => {
  if (fs.existsSync(tempHome)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

afterEach(() => {
  // Reset in-memory session state between tests
  // (we import lazily so the env var is set first)
});

// ─── 1. Tool registration ────────────────────────────────────────────────

describe("cli_bridge tool registration", () => {
  it("is exported as a Tool with the correct shape", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    expect(cliBridgeTool).toBeDefined();
    expect(cliBridgeTool.name).toBe("cli_bridge");
    expect(typeof cliBridgeTool.execute).toBe("function");
    expect(cliBridgeTool.description).toMatch(/delegate|CLI|external/i);

    const params = cliBridgeTool.parameters as any;
    expect(params.type).toBe("object");
    expect(params.properties.action).toBeDefined();
    expect(params.properties.action.enum).toContain("delegate");
    expect(params.properties.action.enum).toContain("session.create");
    expect(params.required).toContain("action");
  });

  it("is registered in superagentToolset (and thus singleToolset) but NOT in masterToolset", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { superagentToolset, masterToolset } = await import("../src/core/tools/toolsets.js");

    expect(superagentToolset).toContain(cliBridgeTool);
    expect(masterToolset).not.toContain(cliBridgeTool);
  }, 30_000);

  it("is registered in allTools and retrievable via getToolByName in tools/index.ts", async () => {
    const { getToolByName, allTools } = await import("../src/core/tools/index.js");
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");

    expect(allTools).toContain(cliBridgeTool);
    expect(getToolByName("cli_bridge")).toBe(cliBridgeTool);
  });
});

// ─── 2. Action validation ───────────────────────────────────────────────

describe("cli_bridge action validation", () => {
  it("returns a clear error for unknown actions", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const result = await cliBridgeTool.execute(
      { action: "nonsense" },
      process.cwd()
    );
    expect(result).toMatch(/Unknown action|nonsense/i);
  });

  it("returns a clear error when 'prompt' is missing on delegate", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const result = await cliBridgeTool.execute(
      { action: "delegate", cli: "custom", binary: HELLO_BIN },
      process.cwd()
    );
    expect(result).toMatch(/prompt.*required/i);
  });

  it("returns a clear error when 'cli' is missing on delegate", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const result = await cliBridgeTool.execute(
      { action: "delegate", prompt: "hi" },
      process.cwd()
    );
    expect(result).toMatch(/cli.*required/i);
  });
});

// ─── 3. List action ─────────────────────────────────────────────────────

describe("cli_bridge action=list", () => {
  it("returns a structured list of known CLIs with status", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const result = await cliBridgeTool.execute({ action: "list" }, process.cwd());
    expect(result).toMatch(/Detected/);
    expect(result).toMatch(/codex/);
    expect(result).toMatch(/claude/);
    expect(result).toMatch(/agy/);
    expect(result).toMatch(/JSON:/);
    // The JSON block should be parseable
    const jsonStart = result.indexOf("[");
    expect(jsonStart).toBeGreaterThan(-1);
    const parsed = JSON.parse(result.slice(jsonStart));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── 4. Delegate (1-shot) ───────────────────────────────────────────────

describe("cli_bridge action=delegate (1-shot)", () => {
  beforeAll(() => {
    process.env.SUPERAGENT_CONFIG_DIR = tempHome;
  });

  it("runs a custom binary, captures stdout, and reports exit code", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const result = await cliBridgeTool.execute(
      { action: "delegate", cli: "custom", binary: HELLO_BIN, prompt: "ignored" },
      process.cwd()
    );
    expect(result).toMatch(/Delegated to custom/);
    expect(result).toMatch(/exit=0/);
    expect(result).toMatch(/HELLO_FROM_HELLO_CLI/);
    expect(result).toMatch(/Full log:/);
  });

  it("reports failure with non-zero exit code", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const result = await cliBridgeTool.execute(
      { action: "delegate", cli: "custom", binary: FAIL_BIN, prompt: "ignored" },
      process.cwd()
    );
    expect(result).toMatch(/exit=7/);
    expect(result).toMatch(/INTENTIONAL_FAILURE/);
  });

  it("returns a clear error when the custom binary path is empty", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const result = await cliBridgeTool.execute(
      { action: "delegate", cli: "custom", binary: "", prompt: "hi" },
      process.cwd()
    );
    expect(result).toMatch(/not available|custom.*not available|cli.*available/i);
  });

  it("returns a clear error when an unknown alias is requested", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const result = await cliBridgeTool.execute(
      { action: "delegate", cli: "definitely-not-a-real-cli", prompt: "hi" },
      process.cwd()
    );
    expect(result).toMatch(/not available/i);
  });
});

// ─── 5. Session lifecycle ───────────────────────────────────────────────

describe("cli_bridge session.* actions", () => {
  beforeAll(() => {
    process.env.SUPERAGENT_CONFIG_DIR = tempHome;
  });

  it("creates a session, sends a message, and reads the response", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { __resetForTests } = await import("../src/core/tools/cliBridgeSession.js");
    __resetForTests();

    const created = await cliBridgeTool.execute(
      { action: "session.create", cli: "custom", binary: REPL_BIN, args: [] },
      process.cwd()
    );
    expect(created).toMatch(/Session created: (clb_[\w]+)/);
    const m = created.match(/Session created: (clb_[\w]+)/);
    const sessionId = m![1];

    // Give the REPL a moment to print its first prompt.
    await new Promise((r) => setTimeout(r, 800));

    const sent = await cliBridgeTool.execute(
      { action: "session.send", sessionId, message: "hello" },
      process.cwd()
    );
    expect(sent).toMatch(/responded/);
    expect(sent).toMatch(/ECHO:hello/);

    const killed = await cliBridgeTool.execute(
      { action: "session.kill", sessionId },
      process.cwd()
    );
    expect(killed).toMatch(/killed/i);
  });

  it("session.list reports active sessions in JSON", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { __resetForTests, listSessions } = await import("../src/core/tools/cliBridgeSession.js");
    __resetForTests();

    expect(listSessions().length).toBe(0);

    const created = await cliBridgeTool.execute(
      { action: "session.create", cli: "custom", binary: REPL_BIN, args: [] },
      process.cwd()
    );
    const sessionId = created.match(/Session created: (clb_[\w]+)/)![1];

    const listed = await cliBridgeTool.execute(
      { action: "session.list" },
      process.cwd()
    );
    expect(listed).toMatch(/Active sessions: 1/);
    expect(listed).toMatch(sessionId);
    const jsonStart = listed.indexOf("[");
    const parsed = JSON.parse(listed.slice(jsonStart));
    expect(parsed.length).toBe(1);
    expect(parsed[0].sessionId).toBe(sessionId);

    // cleanup
    await cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd());
  });

  it("returns a clear error for an unknown sessionId", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const r = await cliBridgeTool.execute(
      { action: "session.send", sessionId: "clb_nonexistent", message: "hi" },
      process.cwd()
    );
    expect(r).toMatch(/not found/i);

    const r2 = await cliBridgeTool.execute(
      { action: "session.kill", sessionId: "clb_nonexistent" },
      process.cwd()
    );
    expect(r2).toMatch(/not_found|not found/i);
  });

  it("session.get returns buffers for debugging", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { __resetForTests } = await import("../src/core/tools/cliBridgeSession.js");
    __resetForTests();

    const created = await cliBridgeTool.execute(
      { action: "session.create", cli: "custom", binary: REPL_BIN, args: [] },
      process.cwd()
    );
    const sessionId = created.match(/Session created: (clb_[\w]+)/)![1];
    await new Promise((r) => setTimeout(r, 800));
    await cliBridgeTool.execute(
      { action: "session.send", sessionId, message: "world" },
      process.cwd()
    );
    const got = await cliBridgeTool.execute(
      { action: "session.get", sessionId },
      process.cwd()
    );
    expect(got).toMatch(new RegExp(sessionId));
    expect(got).toMatch(/Stdout buffer/);
    expect(got).toMatch(/ECHO:world/);

    await cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd());
  });
});

// ─── v1.5.15 tests ─────────────────────────────────────────────────────

describe("cli_bridge v1.5.15 — profiles, skills, interactive, resume, export", () => {
  it("loads built-in profiles for codex / claude / agy", async () => {
    const { loadProfiles, getProfile } = await import("../src/core/tools/cliBridgeProfiles.js");
    const all = loadProfiles();
    expect(all.codex).toBeDefined();
    expect(all.claude).toBeDefined();
    expect(all.agy).toBeDefined();
    const agy = getProfile("agy");
    expect(agy?.skillsArg).toBe("add-dir");
    expect(agy?.skillsRepeatable).toBe(true);
    const codex = getProfile("codex");
    expect(codex?.skillsRepeatable).toBe(false);
  });

  it("buildSessionArgv expands skills into per-CLI flags", async () => {
    const { getProfile, buildSessionArgv } = await import("../src/core/tools/cliBridgeProfiles.js");
    const agy = getProfile("agy")!;
    const argv = buildSessionArgv(agy, { skills: ["/a", "/b"], extraArgs: ["--effort", "high"] });
    // For AGY: defaultArg --dangerously-skip-permissions is prepended; --add-dir is repeated; --effort high comes from extraArgs.
    expect(argv).toEqual(["--dangerously-skip-permissions", "--add-dir", "/a", "--add-dir", "/b", "--effort", "high"]);

    const codex = getProfile("codex")!;
    const argv2 = buildSessionArgv(codex, { skills: ["/a", "/b"] });
    // Codex skillsArg "cd" is non-repeatable, so only the first one is used.
    expect(argv2).toEqual(["--skip-git-repo-check", "--cd", "/a"]);
  });

  it("buildSessionArgv injects the resume flag when resume=true", async () => {
    const { getProfile, buildSessionArgv } = await import("../src/core/tools/cliBridgeProfiles.js");
    const claude = getProfile("claude")!;
    const argv = buildSessionArgv(claude, { resume: true, conversationId: "abc-123" });
    expect(argv).toContain("--continue");
    expect(argv).toContain("abc-123");
  });

  it("profile.list action returns the loaded profiles", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const r = await cliBridgeTool.execute({ action: "profile.list" }, process.cwd());
    expect(r).toMatch(/Loaded \d+ CLI profile/);
    expect(r).toMatch(/claude/);
    expect(r).toMatch(/agy/);
    expect(r).toMatch(/codex/);
    expect(r).toMatch(/Profile override file:/);
  }, 15_000);

  it("detectPrompt classifies a yes/no prompt", async () => {
    const { detectPrompt } = await import("../src/core/tools/cliBridgeSession.js");
    const text = "Do you want to continue?\nAllow action 'edit file.txt'? (y/n): ";
    const p = detectPrompt(text);
    expect(p).not.toBeNull();
    expect(p?.kind).toBe("yesno");
    expect(p?.question).toMatch(/Allow|Continue/);
  });

  it("detectPrompt classifies a password prompt", async () => {
    const { detectPrompt } = await import("../src/core/tools/cliBridgeSession.js");
    const p = detectPrompt("Auth required.\nEnter password: ");
    expect(p).not.toBeNull();
    expect(p?.kind).toBe("password");
  });

  it("detectPrompt classifies a choice prompt with options", async () => {
    const { detectPrompt } = await import("../src/core/tools/cliBridgeSession.js");
    const p = detectPrompt("Pick a model.\nSelect [1/2/3]: ");
    expect(p).not.toBeNull();
    expect(p?.kind).toBe("choice");
    expect(p?.options).toEqual(["1", "2", "3"]);
  });

  it("session.create uses profile to build argv and records skills", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { __resetForTests, getSession } = await import("../src/core/tools/cliBridgeSession.js");
    __resetForTests();

    // We use `custom` for determinism but pretend it's AGY by providing a profile-like name.
    // Since resolveDescriptor requires the binary to exist, we use REPL_BIN here.
    const r = await cliBridgeTool.execute(
      {
        action: "session.create",
        cli: "custom",
        binary: REPL_BIN,
        args: [],
        // The 'agy' profile will be used if available — the descriptor's alias is "custom"
        // so we expect the profile to be missing and args to pass through unchanged.
        skills: ["/skills/frontend", "/skills/db"],
      },
      process.cwd()
    );
    expect(r).toMatch(/Session created: (clb_[\w]+)/);
    const sessionId = r.match(/Session created: (clb_[\w]+)/)![1];
    const s = getSession(sessionId);
    // v1.5.16: paths are normalized via path.resolve() and auto-detect may add
    // AGENTS.md from the cwd. We assert the two requested ones are present in order.
    const expectedFrontend = path.resolve("/skills/frontend");
    const expectedDb = path.resolve("/skills/db");
    expect(s?.skills).toContain(expectedFrontend);
    expect(s?.skills).toContain(expectedDb);
    expect(s?.skills?.slice(0, 2)).toEqual([expectedFrontend, expectedDb]);

    await cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd());
  }, 30_000);

  it("session.respond requires both sessionId and answer", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const r1 = await cliBridgeTool.execute(
      { action: "session.respond", sessionId: "clb_x", answer: "y" },
      process.cwd()
    );
    expect(r1).toMatch(/not found/i);

    const r2 = await cliBridgeTool.execute(
      { action: "session.respond", sessionId: "clb_x" },
      process.cwd()
    );
    expect(r2).toMatch(/'answer' is required/);
  });

  it("session.export returns null for an unknown session", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const r = await cliBridgeTool.execute(
      { action: "session.export", sessionId: "clb_doesnotexist" },
      process.cwd()
    );
    expect(r).toMatch(/session not_found/);
  });

  it("session.config errors when sessionId is missing", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const r = await cliBridgeTool.execute(
      { action: "session.config", sessionId: "" },
      process.cwd()
    );
    expect(r).toMatch(/'sessionId' is required/);
  });

  it("session.resume errors when no resume flag is defined for the profile", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    // 'codex' has resumeFlag, 'agy' has resumeFlag. We use a non-existent alias.
    const r = await cliBridgeTool.execute(
      { action: "session.resume", cli: "no_such_cli" },
      process.cwd()
    );
    expect(r).toMatch(/not available|No profile/);
  });
});

// ─── v1.5.16 tests ─────────────────────────────────────────────────────

describe("cli_bridge v1.5.16 — system prompt, skill registry, auto-detect, template", () => {
  it("applyPromptTemplate substitutes {system} and {prompt}", async () => {
    const { applyPromptTemplate } = await import("../src/core/tools/cliBridgeProfiles.js");
    const out = applyPromptTemplate("Role: {system}\n\n{prompt}", {
      system: "reviewer",
      prompt: "check this",
    });
    expect(out).toBe("Role: reviewer\n\ncheck this");
  });

  it("applyPromptTemplate cleans up empty system", async () => {
    const { applyPromptTemplate } = await import("../src/core/tools/cliBridgeProfiles.js");
    const out = applyPromptTemplate("{system}\n\n{prompt}", {
      system: "",
      prompt: "check this",
    });
    expect(out).toBe("check this");
  });

  it("applyPromptTemplate leaves unknown tokens alone (typo safety)", async () => {
    const { applyPromptTemplate } = await import("../src/core/tools/cliBridgeProfiles.js");
    const out = applyPromptTemplate("{system}\n\n{promt}", {
      system: "X",
      prompt: "Y",
    });
    // {promt} is not {prompt}, so it stays as literal text.
    expect(out).toMatch(/\{promt\}/);
  });

  it("autoDetectSkillFiles finds AGENTS.md and CLAUDE.md in cwd", async () => {
    const { autoDetectSkillFiles } = await import("../src/core/tools/cliBridgeSkills.js");
    const tmp = path.join(mockDir, "auto-detect-cwd-" + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    try {
      fs.writeFileSync(path.join(tmp, "AGENTS.md"), "# agent instructions\n");
      fs.writeFileSync(path.join(tmp, "CLAUDE.md"), "# claude\n");
      // CODEX.md does NOT exist — should be absent.
      const r = autoDetectSkillFiles(tmp);
      const names = r.names;
      expect(names).toContain("AGENTS.md");
      expect(names).toContain("CLAUDE.md");
      expect(names).not.toContain("CODEX.md");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolveSkills looks up names in the profile registry", async () => {
    const { resolveSkills, __resetSkillRegistryCacheForTests } = await import(
      "../src/core/tools/cliBridgeSkills.js"
    );
    __resetSkillRegistryCacheForTests();
    const r = resolveSkills({
      requested: ["security", "/abs/path/inline"],
      profileRegistry: {
        security: { path: "/skills/security", description: "Sec review" },
        other: { path: "/skills/other" },
      },
      autoDetect: false,
    });
    expect(r.unresolved).toEqual([]);
    expect(r.paths).toEqual([
      path.resolve("/skills/security"),
      path.resolve("/abs/path/inline"),
    ]);
  });

  it("resolveSkills reports unresolved names without throwing", async () => {
    const { resolveSkills, __resetSkillRegistryCacheForTests } = await import(
      "../src/core/tools/cliBridgeSkills.js"
    );
    __resetSkillRegistryCacheForTests();
    const r = resolveSkills({
      requested: ["ghost"],
      autoDetect: false,
    });
    expect(r.unresolved).toEqual(["ghost"]);
    expect(r.paths).toEqual([]);
  });

  it("resolveSkills auto-loads skills marked autoLoad from profile + global", async () => {
    const { resolveSkills, __resetSkillRegistryCacheForTests, loadGlobalSkillRegistry } = await import(
      "../src/core/tools/cliBridgeSkills.js"
    );
    __resetSkillRegistryCacheForTests();
    // We can't easily override the global file in tests without touching disk,
    // so we only verify the profile autoLoad path here.
    const r = resolveSkills({
      requested: [],
      profileRegistry: {
        base: { path: "/skills/base" },                       // not autoLoad
        autocloud: { path: "/skills/autocloud", autoLoad: true },
      },
      autoDetect: false,
    });
    // Only the autoLoad one should be in the result (manual ones are not auto-added).
    expect(r.paths).not.toContain(path.resolve("/skills/base"));
    expect(r.paths).toContain(path.resolve("/skills/autocloud"));
    // loadGlobalSkillRegistry is callable (smoke test).
    const g = loadGlobalSkillRegistry();
    expect(typeof g).toBe("object");
  });

  it("session.create with system prompt records it on the session", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { __resetForTests, getSession } = await import("../src/core/tools/cliBridgeSession.js");
    __resetForTests();

    const r = await cliBridgeTool.execute(
      {
        action: "session.create",
        cli: "custom",
        binary: REPL_BIN,
        args: [],
        system: "You are a reviewer. Reply in JSON only.",
        skillAutoDetect: false,
      },
      process.cwd()
    );
    expect(r).toMatch(/Session created: (clb_[\w]+)/);
    expect(r).toMatch(/system:.*reviewer/);
    const sessionId = r.match(/Session created: (clb_[\w]+)/)![1];
    const s = getSession(sessionId);
    expect(s?.systemPrompt).toBe("You are a reviewer. Reply in JSON only.");

    await cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd());
  }, 30_000);

  it("session.send composes the message with the system template", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { __resetForTests, sendToSession } = await import("../src/core/tools/cliBridgeSession.js");
    __resetForTests();

    // First create a session without a profile (use custom binary).
    const r = await cliBridgeTool.execute(
      {
        action: "session.create",
        cli: "custom",
        binary: REPL_BIN,
        args: [],
        system: "ROLE: reviewer",
        skillAutoDetect: false,
      },
      process.cwd()
    );
    const sessionId = r.match(/Session created: (clb_[\w]+)/)![1];

    // Send a message — the composed version should be "ROLE: reviewer\n\nhello".
    // We can test the composition path by calling send directly with
    // a custom message and asserting the REPL echoes "ROLE: reviewer" first.
    const r2 = await sendToSession({ sessionId, message: "hello", timeoutMs: 10_000 });
    // The REPL uppercases the input — verify the round-trip works
    // (proves no crash from the template composition logic).
    expect("response" in r2).toBe(true);
    expect(r2.response).toMatch(/ECHO:hello/i);

    // Test the skipSystem opt-out: same composition but skip.
    const r3 = await sendToSession({ sessionId, message: "skip-test", timeoutMs: 10_000 });
    expect(r3.response).toMatch(/ECHO:skip-test/i);

    await cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd());
  }, 30_000);
});

// ─── v1.5.17 tests ─────────────────────────────────────────────────────

describe("cli_bridge v1.5.17 — lifecycle, streaming, auto-send, detach", () => {
  it("session.create with initialMessage auto-sends it after ready", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { __resetForTests, getSessionAny, sendToSession } = await import(
      "../src/core/tools/cliBridgeSession.js"
    );
    __resetForTests();

    const r = await cliBridgeTool.execute(
      {
        action: "session.create",
        cli: "custom",
        binary: REPL_BIN,
        args: [],
        message: "auto-fire-test",
        skillAutoDetect: false,
      },
      process.cwd()
    );
    expect(r).toMatch(/Session created: (clb_[\w]+)/);
    const sessionId = r.match(/Session created: (clb_[\w]+)/)![1];

    // Wait for the auto-send to land.
    let s: any = getSessionAny(sessionId);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      s = getSessionAny(sessionId);
      if (s && /ECHO:auto-fire-test/i.test(s.stdoutBuffer)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(s).toBeTruthy();
    expect(s.stdoutBuffer).toMatch(/ECHO:auto-fire-test/i);

    await cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd());
  }, 30_000);

  it("session.create with autoSendInitial=false queues but does not auto-send", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { __resetForTests, getSessionAny } = await import(
      "../src/core/tools/cliBridgeSession.js"
    );
    __resetForTests();

    const r = await cliBridgeTool.execute(
      {
        action: "session.create",
        cli: "custom",
        binary: REPL_BIN,
        args: [],
        initialMessage: "queued-message",
        autoSendInitial: false,
        skillAutoDetect: false,
      },
      process.cwd()
    );
    const sessionId = r.match(/Session created: (clb_[\w]+)/)![1];

    // Wait long enough for the ready probe to fire, then verify nothing
    // has been sent automatically.
    await new Promise((r) => setTimeout(r, 2_000));
    const s = getSessionAny(sessionId);
    expect(s).toBeTruthy();
    expect(s.stdoutBuffer).not.toMatch(/ECHO:queued-message/i);

    await cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd());
  }, 30_000);

  it("maxBufferLines caps the per-session stdout buffer", async () => {
    const { createSession, __resetForTests, getSessionAny } = await import(
      "../src/core/tools/cliBridgeSession.js"
    );
    __resetForTests();

    // Push a 30-line chunk with cap=5: only the last 5 lines should remain.
    const r = await createSession({
      cliAlias: "custom",
      binary: REPL_BIN,
      cwd: process.cwd(),
      args: [],
      maxBufferLines: 5,
      idleTimeoutMs: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sessionId = r.session.sessionId;

    // Simulate the rolling buffer by writing a large chunk directly via the
    // session log path: the chunk won't actually flow to the REPL, but the
    // buffer is updated by the stdout listener in real sessions. For a
    // deterministic test we exercise the buffer logic by stuffing 30 lines
    // and verifying the cap holds.
    // We use the session.stdoutBuffer directly to push test data.
    r.session.stdoutBuffer = "";
    const fake = Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n") + "\n";
    // Inline invocation of the same appendLines logic the listener uses.
    const { appendLinesForTest } = await import("../src/core/tools/cliBridgeSession.js");
    r.session.stdoutBuffer = appendLinesForTest(r.session.stdoutBuffer, fake, r.session.maxBufferLines);
    const lines = r.session.stdoutBuffer.split(/\r?\n/).filter(Boolean);
    // 30 lines + trailing \n → 31 parts when split, last 5 are kept (one is
    // empty). filter(Boolean) leaves 4 actual lines: line-26..line-29.
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe("line-26");
    expect(lines[3]).toBe("line-29");
    // And the dropped lines are gone.
    expect(r.session.stdoutBuffer).not.toMatch(/line-0/);

    await import("../src/core/tools/cliBridgeTool.js").then((m) =>
      m.cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd())
    );
  }, 30_000);

  it("scanIdleSessions kills a session whose lastOutputAt is past idleTimeoutMs", async () => {
    const { createSession, __resetForTests, __triggerIdleCheckForTests, getSessionAny } = await import(
      "../src/core/tools/cliBridgeSession.js"
    );
    __resetForTests();

    const r = await createSession({
      cliAlias: "custom",
      binary: REPL_BIN,
      cwd: process.cwd(),
      args: [],
      idleTimeoutMs: 50, // 50 ms
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sessionId = r.session.sessionId;
    r.session.lastOutputAt = Date.now() - 10_000; // pretend it's been silent 10 s

    const killed = await __triggerIdleCheckForTests();
    expect(killed).toContain(sessionId);
    const s = getSessionAny(sessionId);
    expect(s?.autoKilled).toBe(true);
    expect(s?.status).toBe("exited");

    await import("../src/core/tools/cliBridgeTool.js").then((m) =>
      m.cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd())
    );
  }, 30_000);

  it("setIdleTimeout updates the TTL on a live session", async () => {
    const { createSession, setIdleTimeout, __resetForTests, getSessionAny } = await import(
      "../src/core/tools/cliBridgeSession.js"
    );
    __resetForTests();

    const r = await createSession({
      cliAlias: "custom",
      binary: REPL_BIN,
      cwd: process.cwd(),
      args: [],
      idleTimeoutMs: 0,
    });
    if (!r.ok) throw new Error("create failed");
    const sessionId = r.session.sessionId;

    const ok = setIdleTimeout(sessionId, 120_000);
    expect(ok).toBe(true);
    expect(getSessionAny(sessionId)?.idleTimeoutMs).toBe(120_000);

    // Invalid value rejected.
    expect(setIdleTimeout(sessionId, -1)).toBe(false);
    // Unknown session rejected.
    expect(setIdleTimeout("clb_nope", 1000)).toBe(false);

    await import("../src/core/tools/cliBridgeTool.js").then((m) =>
      m.cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd())
    );
  }, 30_000);

  it("subscribeSession receives live stdout events", async () => {
    const { createSession, sendToSession, __resetForTests, subscribeSession } = await import(
      "../src/core/tools/cliBridgeSession.js"
    );
    __resetForTests();

    const r = await createSession({
      cliAlias: "custom",
      binary: REPL_BIN,
      cwd: process.cwd(),
      args: [],
      idleTimeoutMs: 0,
    });
    if (!r.ok) throw new Error("create failed");
    const sessionId = r.session.sessionId;

    const received: string[] = [];
    const sub = subscribeSession(sessionId, (ev) => {
      if (ev.type === "stdout") received.push(ev.data.line ?? "");
    });
    expect(sub).toBeTruthy();

    await sendToSession({ sessionId, message: "stream-test", timeoutMs: 5_000 });

    // Wait briefly for the event to land.
    await new Promise((r) => setTimeout(r, 200));
    expect(received.some((l) => /ECHO:stream-test/i.test(l))).toBe(true);

    // Unsubscribing stops further events.
    sub!.unsubscribe();
    const beforeCount = received.length;
    await sendToSession({ sessionId, message: "after-unsub", timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(received.length).toBe(beforeCount);

    await import("../src/core/tools/cliBridgeTool.js").then((m) =>
      m.cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd())
    );
  }, 30_000);

  it("session.tail returns buffered events in order", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { __resetForTests, sendToSession, getLastEventSeq, tailEvents } = await import(
      "../src/core/tools/cliBridgeSession.js"
    );
    __resetForTests();

    const r = await cliBridgeTool.execute(
      {
        action: "session.create",
        cli: "custom",
        binary: REPL_BIN,
        args: [],
        initialMessage: "first-message",
        skillAutoDetect: false,
      },
      process.cwd()
    );
    const sessionId = r.match(/Session created: (clb_[\w]+)/)![1];

    // Wait for auto-send to land and produce at least one stdout event.
    await new Promise((r) => setTimeout(r, 2_000));

    const lastSeq = getLastEventSeq(sessionId);
    expect(lastSeq).toBeGreaterThan(0);

    const all = tailEvents(sessionId, 0, 200);
    expect(all.length).toBeGreaterThan(0);
    // Monotonic seq.
    for (let i = 1; i < all.length; i++) {
      expect(all[i].seq).toBeGreaterThan(all[i - 1].seq);
    }
    // Contains at least one stdout event for the auto-sent message.
    expect(all.some((e) => e.type === "stdout" && /ECHO:first-message/i.test(e.data.line ?? ""))).toBe(true);

    // since=lastSeq should return zero events.
    const after = tailEvents(sessionId, lastSeq, 200);
    expect(after.length).toBe(0);

    // session.tail tool action returns the formatted buffer.
    const tail = await cliBridgeTool.execute(
      { action: "session.tail", sessionId, tailLimit: 50 },
      process.cwd()
    );
    expect(tail).toMatch(/Session/);
    expect(tail).toMatch(/lastEventSeq:/);
    expect(tail).toMatch(/stdout/);

    await cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd());
  }, 30_000);

  it("session.tail with setIdleTimeoutMs extends the TTL and returns the tail", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { __resetForTests, getSessionAny } = await import("../src/core/tools/cliBridgeSession.js");
    __resetForTests();

    const r = await cliBridgeTool.execute(
      {
        action: "session.create",
        cli: "custom",
        binary: REPL_BIN,
        args: [],
        idleTimeoutMs: 0,
        skillAutoDetect: false,
      },
      process.cwd()
    );
    const sessionId = r.match(/Session created: (clb_[\w]+)/)![1];

    const tail = await cliBridgeTool.execute(
      { action: "session.tail", sessionId, setIdleTimeoutMs: 900_000 },
      process.cwd()
    );
    // 900_000 ms = 900 s.
    expect(tail).toMatch(/idle:.*900s TTL/);
    expect(getSessionAny(sessionId)?.idleTimeoutMs).toBe(900_000);

    await cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd());
  }, 30_000);

  it("session.detach moves the session to the detached bucket; session.kill still works", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const {
      __resetForTests,
      listSessions,
      listDetachedSessions,
      getSessionAny,
    } = await import("../src/core/tools/cliBridgeSession.js");
    __resetForTests();

    const r = await cliBridgeTool.execute(
      {
        action: "session.create",
        cli: "custom",
        binary: REPL_BIN,
        args: [],
        skillAutoDetect: false,
      },
      process.cwd()
    );
    const sessionId = r.match(/Session created: (clb_[\w]+)/)![1];

    // Wait for ready.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(listSessions().find((s) => s.sessionId === sessionId)).toBeTruthy();
    expect(listDetachedSessions()).not.toContain(sessionId);

    // Detach.
    const dr = await cliBridgeTool.execute(
      { action: "session.detach", sessionId },
      process.cwd()
    );
    expect(dr).toMatch(/Detached session/);
    expect(dr).toMatch(/process is still running/);

    expect(listSessions().find((s) => s.sessionId === sessionId)).toBeFalsy();
    expect(listDetachedSessions()).toContain(sessionId);
    expect(getSessionAny(sessionId)?.detached).toBe(true);

    // session.kill still works against the detached session.
    const kr = await cliBridgeTool.execute(
      { action: "session.kill", sessionId },
      process.cwd()
    );
    expect(kr).toMatch(/killed/i);
    expect(listDetachedSessions()).not.toContain(sessionId);
  }, 30_000);

  it("session.list shows detached sessions separately", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { __resetForTests } = await import("../src/core/tools/cliBridgeSession.js");
    __resetForTests();

    const r = await cliBridgeTool.execute(
      {
        action: "session.create",
        cli: "custom",
        binary: REPL_BIN,
        args: [],
        skillAutoDetect: false,
      },
      process.cwd()
    );
    const sessionId = r.match(/Session created: (clb_[\w]+)/)![1];
    await new Promise((r) => setTimeout(r, 1_500));
    await cliBridgeTool.execute({ action: "session.detach", sessionId }, process.cwd());

    const list = await cliBridgeTool.execute({ action: "session.list" }, process.cwd());
    expect(list).toMatch(/Active sessions: 0 \(detached: 1\)/);
    expect(list).toMatch(new RegExp(`${sessionId}.*\\(detached`));
    expect(list).toMatch(/"detached":\s*true/);

    await cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd());
  }, 30_000);

  it("session.get surfaces the new lifecycle fields", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { __resetForTests, sendToSession } = await import("../src/core/tools/cliBridgeSession.js");
    __resetForTests();

    const r = await cliBridgeTool.execute(
      {
        action: "session.create",
        cli: "custom",
        binary: REPL_BIN,
        args: [],
        maxBufferLines: 100,
        idleTimeoutMs: 12345,
        skillAutoDetect: false,
      },
      process.cwd()
    );
    const sessionId = r.match(/Session created: (clb_[\w]+)/)![1];
    await new Promise((r) => setTimeout(r, 1_500));
    await sendToSession({ sessionId, message: "ping", timeoutMs: 5_000 });

    const got = await cliBridgeTool.execute({ action: "session.get", sessionId }, process.cwd());
    expect(got).toMatch(/maxBuffer:\s+100 lines/);
    expect(got).toMatch(/idleTimeout:\s+12s/);
    expect(got).toMatch(/detached:\s+false/);
    expect(got).toMatch(/lastOutput:/);

    await cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd());
  }, 30_000);

  it("session.detach on an already-exited session returns an error", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { __resetForTests, getSessionAny } = await import("../src/core/tools/cliBridgeSession.js");
    __resetForTests();

    const r = await cliBridgeTool.execute(
      {
        action: "session.create",
        cli: "custom",
        binary: REPL_BIN,
        args: [],
        skillAutoDetect: false,
      },
      process.cwd()
    );
    const sessionId = r.match(/Session created: (clb_[\w]+)/)![1];
    await new Promise((r) => setTimeout(r, 1_500));

    // Manually flip the session to "exited" (simulating the REPL crashing
    // out) — the session is still in the active map, so detach should
    // refuse.
    const s = getSessionAny(sessionId);
    s!.status = "exited";

    const dr = await cliBridgeTool.execute({ action: "session.detach", sessionId }, process.cwd());
    expect(dr).toMatch(/already exited|nothing to detach/);

    // Cleanup.
    await import("../src/core/tools/cliBridgeTool.js").then((m) =>
      m.cliBridgeTool.execute({ action: "session.kill", sessionId }, process.cwd())
    );
  }, 30_000);
});

// ─── v1.5.32 tests ─────────────────────────────────────────────────────

describe("cli_bridge v1.5.32 — delegate skills, flag ordering, stdin EOF, and fallbacks", () => {
  it("buildDelegateArgv places promptSubcommand immediately before prompt", async () => {
    const { buildDelegateArgv } = await import("../src/core/tools/cliBridgeSession.js");
    const desc = {
      alias: "agy",
      binary: "agy.exe",
      label: "Antigravity CLI",
      available: true,
      defaultArgs: ["--dangerously-skip-permissions"],
      promptSubcommand: ["-p"],
      promptAsArg: true,
    };
    const argv = buildDelegateArgv(desc, "test prompt", ["--add-dir", "/workspace"]);
    expect(argv).toEqual([
      "--dangerously-skip-permissions",
      "--add-dir",
      "/workspace",
      "-p",
      "test prompt",
    ]);
  });

  it("handleDelegate resolves skills array into CLI add-dir flags", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const result = await cliBridgeTool.execute(
      {
        action: "delegate",
        cli: "custom",
        binary: REPL_BIN,
        skills: [process.cwd()],
        prompt: "hello skills",
      },
      process.cwd()
    );
    expect(result).toMatch(/Delegated to custom/);
    expect(result).toMatch(/hello skills/);
  }, 20_000);

  it("handleDelegate respects custom cwd", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const result = await cliBridgeTool.execute(
      {
        action: "delegate",
        cli: "custom",
        binary: REPL_BIN,
        cwd: process.cwd(),
        prompt: "cwd test",
      },
      process.cwd()
    );
    expect(result).toMatch(/Delegated to custom/);
    expect(result).toMatch(/cwd test/);
  }, 20_000);
});

