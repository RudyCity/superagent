import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  isPathInScope,
  canonicalizeTarget,
  validateToolCallAgainstFileScope,
} from "../src/core/agent/fileScopeGuard.js";

describe("Delegated fileScope hard enforcement (DEEP-02)", () => {
  const tmpBase = path.join(os.tmpdir(), `superagent_scope_test_${Date.now()}`);
  const workspaceRoot = path.join(tmpBase, "workspace");
  const authDir = path.join(workspaceRoot, "src", "auth");
  const otherDir = path.join(workspaceRoot, "src", "other");
  const outsideDir = path.join(tmpBase, "outside");

  // Setup test filesystem structure
  fs.mkdirSync(authDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const authFile = path.join(authDir, "login.ts");
  const otherFile = path.join(otherDir, "secret.ts");
  const outsideFile = path.join(outsideDir, "external.txt");

  fs.writeFileSync(authFile, "export const login = true;");
  fs.writeFileSync(otherFile, "export const secret = 123;");
  fs.writeFileSync(outsideFile, "outside content");

  const fileScope = ["src/auth/**"];

  it("allows paths strictly inside the fileScope", () => {
    const res = isPathInScope("src/auth/login.ts", fileScope, workspaceRoot);
    expect(res.inScope).toBe(true);

    const absRes = isPathInScope(authFile, fileScope, workspaceRoot);
    expect(absRes.inScope).toBe(true);

    // Non-existent child file to be created in allowed scope
    const newFile = isPathInScope("src/auth/new_handler.ts", fileScope, workspaceRoot);
    expect(newFile.inScope).toBe(true);
  });

  it("denies sibling directories outside the fileScope", () => {
    const res = isPathInScope("src/other/secret.ts", fileScope, workspaceRoot);
    expect(res.inScope).toBe(false);
    expect(res.reason).toContain("outside allowed fileScope");

    const absRes = isPathInScope(otherFile, fileScope, workspaceRoot);
    expect(absRes.inScope).toBe(false);
  });

  it("denies directory traversal attempts escaping fileScope", () => {
    // Relative traversal escaping src/auth to src/other
    const travRes = isPathInScope("src/auth/../other/secret.ts", fileScope, workspaceRoot);
    expect(travRes.inScope).toBe(false);

    // Deep traversal escaping workspace completely
    const deepTrav = isPathInScope("src/auth/../../../../outside.txt", fileScope, workspaceRoot);
    expect(deepTrav.inScope).toBe(false);
  });

  it("detects and denies symlinks escaping fileScope", () => {
    const symlinkPath = path.join(authDir, "symlink_to_other.ts");
    try {
      fs.symlinkSync(otherFile, symlinkPath, "file");
    } catch {
      // Symlink creation may require elevated privileges on some Windows environments
    }

    if (fs.existsSync(symlinkPath)) {
      const res = isPathInScope("src/auth/symlink_to_other.ts", fileScope, workspaceRoot);
      expect(res.inScope).toBe(false);
      expect(res.reason).toMatch(/Symlink\/reparse target/);
      try { fs.unlinkSync(symlinkPath); } catch {}
    }
  });

  it("validates file read and write tool calls against fileScope", () => {
    // Allowed read
    const allowedRead = validateToolCallAgainstFileScope(
      fileScope,
      { id: "1", name: "read", args: { filePaths: ["src/auth/login.ts"] } },
      workspaceRoot
    );
    expect(allowedRead.allowed).toBe(true);

    // Denied read (outside scope)
    const deniedRead = validateToolCallAgainstFileScope(
      fileScope,
      { id: "2", name: "read", args: { filePaths: ["package.json"] } },
      workspaceRoot
    );
    expect(deniedRead.allowed).toBe(false);
    expect(deniedRead.reason).toContain("outside allowed fileScope");

    // Denied write (traversal to sibling)
    const deniedWrite = validateToolCallAgainstFileScope(
      fileScope,
      { id: "3", name: "write_to_file", args: { files: [{ filePath: "src/auth/../other/hacked.ts", content: "hacked" }] } },
      workspaceRoot
    );
    expect(deniedWrite.allowed).toBe(false);
  });

  it("validates shell operations and blocks chdir or traversal escapes", () => {
    // Allowed cwd
    const allowedCwd = validateToolCallAgainstFileScope(
      fileScope,
      { id: "4", name: "run_command", args: { command: "ls", cwd: "src/auth" } },
      workspaceRoot
    );
    expect(allowedCwd.allowed).toBe(true);

    // Denied outside cwd
    const deniedCwd = validateToolCallAgainstFileScope(
      fileScope,
      { id: "5", name: "run_command", args: { command: "ls", cwd: "src/other" } },
      workspaceRoot
    );
    expect(deniedCwd.allowed).toBe(false);

    // Denied cd escaping scope
    const deniedCd = validateToolCallAgainstFileScope(
      fileScope,
      { id: "6", name: "run_command", args: { command: "cd ../other && ls", cwd: "src/auth" } },
      workspaceRoot
    );
    expect(deniedCd.allowed).toBe(false);
    expect(deniedCd.reason).toMatch(/cd outside fileScope/);

    // Denied traversal in command arguments
    const deniedArgTrav = validateToolCallAgainstFileScope(
      fileScope,
      { id: "7", name: "run_command", args: { command: "cat ../other/secret.ts", cwd: "src/auth" } },
      workspaceRoot
    );
    expect(deniedArgTrav.allowed).toBe(false);
  });

  it("denies absolute path shell probes outside delegated fileScope (DEEP-02 independent audit probe)", () => {
    const agentScope = ["src/core/agent/**"];
    const agentCwd = "src/core/agent";
    const absPackageJson = path.join(workspaceRoot, "package.json");

    // 1. Direct POSIX-style command referencing absolute package.json
    const probePosix = validateToolCallAgainstFileScope(
      agentScope,
      { id: "probe-1", name: "run_command", args: { command: `cat "${absPackageJson}"`, cwd: agentCwd } },
      workspaceRoot
    );
    expect(probePosix.allowed).toBe(false);
    expect(probePosix.reason).toMatch(/outside allowed fileScope/);

    // 2. Windows cmd type referencing absolute package.json with drive letter & quotes
    const probeCmd = validateToolCallAgainstFileScope(
      agentScope,
      { id: "probe-2", name: "run_command", args: { command: `type "${absPackageJson}"`, cwd: agentCwd } },
      workspaceRoot
    );
    expect(probeCmd.allowed).toBe(false);
    expect(probeCmd.reason).toMatch(/outside allowed fileScope/);

    // 3. PowerShell Get-Content referencing absolute package.json
    const probePwsh = validateToolCallAgainstFileScope(
      agentScope,
      { id: "probe-3", name: "run_command", args: { command: `Get-Content -Path '${absPackageJson}'`, cwd: agentCwd } },
      workspaceRoot
    );
    expect(probePwsh.allowed).toBe(false);
    expect(probePwsh.reason).toMatch(/outside allowed fileScope/);

    // 4. Git Bash style path: /c/... or /d/...
    const gitBashDrive = (process.platform === "win32"
      ? `/${absPackageJson[0].toLowerCase()}/${absPackageJson.slice(3).replace(/\\/g, "/")}`
      : absPackageJson);
    const probeGitBash = validateToolCallAgainstFileScope(
      agentScope,
      { id: "probe-4", name: "run_command", args: { command: `cat ${gitBashDrive}`, cwd: agentCwd } },
      workspaceRoot
    );
    expect(probeGitBash.allowed).toBe(false);
    expect(probeGitBash.reason).toMatch(/outside allowed fileScope/);
  });

  it("denies shell redirection escaping fileScope", () => {
    // Redirection to traversal path
    const res1 = validateToolCallAgainstFileScope(
      fileScope,
      { id: "redir-1", name: "run_command", args: { command: "echo data > ../other/secret.txt", cwd: "src/auth" } },
      workspaceRoot
    );
    expect(res1.allowed).toBe(false);
    expect(res1.reason).toMatch(/outside allowed fileScope/);

    // Redirection to absolute outside path
    const outsideFile = path.join(tmpBase, "leak.txt");
    const res2 = validateToolCallAgainstFileScope(
      fileScope,
      { id: "redir-2", name: "run_command", args: { command: `echo leak >> "${outsideFile}"`, cwd: "src/auth" } },
      workspaceRoot
    );
    expect(res2.allowed).toBe(false);

    // PowerShell Out-File redirection
    const res3 = validateToolCallAgainstFileScope(
      fileScope,
      { id: "redir-3", name: "run_command", args: { command: `Get-Process | Out-File -FilePath "${outsideFile}"`, cwd: "src/auth" } },
      workspaceRoot
    );
    expect(res3.allowed).toBe(false);

    // Pipeline tee redirection
    const res4 = validateToolCallAgainstFileScope(
      fileScope,
      { id: "redir-4", name: "run_command", args: { command: `ls | tee "${outsideFile}"`, cwd: "src/auth" } },
      workspaceRoot
    );
    expect(res4.allowed).toBe(false);

    // Allow standard null sink redirection
    const resNull = validateToolCallAgainstFileScope(
      fileScope,
      { id: "redir-null", name: "run_command", args: { command: "ls > /dev/null 2>&1", cwd: "src/auth" } },
      workspaceRoot
    );
    expect(resNull.allowed).toBe(true);
  });

  it("denies nested shell commands and encoded execution", () => {
    const absPackageJson = path.join(workspaceRoot, "package.json");

    // bash -c nested
    const resBash = validateToolCallAgainstFileScope(
      fileScope,
      { id: "nest-1", name: "run_command", args: { command: `bash -c "cat ${absPackageJson}"`, cwd: "src/auth" } },
      workspaceRoot
    );
    expect(resBash.allowed).toBe(false);

    // cmd.exe /c nested
    const resCmd = validateToolCallAgainstFileScope(
      fileScope,
      { id: "nest-2", name: "run_command", args: { command: `cmd.exe /c "type ${absPackageJson}"`, cwd: "src/auth" } },
      workspaceRoot
    );
    expect(resCmd.allowed).toBe(false);

    // powershell -Command nested
    const resPs = validateToolCallAgainstFileScope(
      fileScope,
      { id: "nest-3", name: "run_command", args: { command: `powershell -Command "Get-Content ${absPackageJson}"`, cwd: "src/auth" } },
      workspaceRoot
    );
    expect(resPs.allowed).toBe(false);

    // Encoded PowerShell execution (fail closed)
    const resEnc = validateToolCallAgainstFileScope(
      fileScope,
      { id: "nest-4", name: "run_command", args: { command: "powershell -EncodedCommand aW52b2tl...", cwd: "src/auth" } },
      workspaceRoot
    );
    expect(resEnc.allowed).toBe(false);
    expect(resEnc.reason).toMatch(/Encoded shell commands/);
  });

  it("denies script invocations outside fileScope", () => {
    const outsideScript = path.join(tmpBase, "run.js");

    const resNode = validateToolCallAgainstFileScope(
      fileScope,
      { id: "script-1", name: "run_command", args: { command: `node "${outsideScript}"`, cwd: "src/auth" } },
      workspaceRoot
    );
    expect(resNode.allowed).toBe(false);

    const resPy = validateToolCallAgainstFileScope(
      fileScope,
      { id: "script-2", name: "run_command", args: { command: `python ../other/test.py`, cwd: "src/auth" } },
      workspaceRoot
    );
    expect(resPy.allowed).toBe(false);
  });

  it("integrates with ToolExecutor.executeTools to block delegated fileScope shell escapes", async () => {
    const { ToolExecutor } = await import("../src/core/agent/ToolExecutor.js");
    const absPackageJson = path.join(workspaceRoot, "package.json");

    const events: any[] = [];
    const mockAgent: any = {
      fileScope: ["src/core/agent/**"],
      workingDirectory: workspaceRoot,
      worktreePath: workspaceRoot,
      getActiveTools: async () => [],
      onEvent: (ev: any) => events.push(ev),
    };

    const toolCalls = [
      {
        id: "call-tool-exec-probe",
        name: "run_command",
        args: { command: `cat "${absPackageJson}"`, cwd: "src/core/agent" },
      },
    ];

    const results = await ToolExecutor.executeTools(
      mockAgent,
      toolCalls,
      [],
      [],
      false,
      "system prompt"
    );

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].result).toContain("Access denied by delegated fileScope");
    expect(results[0].result).toContain("package.json");
  });

  it("denies environment-variable based shell fileScope escapes (P0 independent repros & variants)", () => {
    const agentScope = ["src/core/agent/**"];
    const agentCwd = "src/core/agent";

    // Independent Repro 1: PowerShell $env:WINDIR\win.ini
    const repro1 = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "repro-1",
        name: "run_command",
        args: { command: 'powershell -Command "Get-Content $env:WINDIR\\win.ini"', cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(repro1.allowed).toBe(false);
    expect(repro1.reason).toMatch(/outside allowed fileScope|unverified environment variable/);

    // Independent Repro 2: cmd /c type %WINDIR%\win.ini
    const repro2 = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "repro-2",
        name: "run_command",
        args: { command: "cmd /c type %WINDIR%\\win.ini", cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(repro2.allowed).toBe(false);
    expect(repro2.reason).toMatch(/outside allowed fileScope|unverified environment variable/);

    // Bracketed PowerShell env var: ${env:WINDIR}\win.ini
    const pwshBracketed = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "pwsh-bracketed",
        name: "run_command",
        args: { command: 'powershell -Command "Get-Content ${env:WINDIR}\\win.ini"', cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(pwshBracketed.allowed).toBe(false);

    // cmd %USERPROFILE% and delayed expansion !USERPROFILE!
    const cmdUserProfile = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "cmd-userprofile",
        name: "run_command",
        args: { command: "cmd /c type %USERPROFILE%\\secret.txt", cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(cmdUserProfile.allowed).toBe(false);

    const cmdDelayed = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "cmd-delayed",
        name: "run_command",
        args: { command: "cmd /c type !USERPROFILE!\\secret.txt", cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(cmdDelayed.allowed).toBe(false);

    // POSIX $HOME, ${HOME}, and tilde (~)
    const posixHome = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "posix-home",
        name: "run_command",
        args: { command: "bash -c 'cat $HOME/.bashrc'", cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(posixHome.allowed).toBe(false);

    const posixBracketHome = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "posix-bracket-home",
        name: "run_command",
        args: { command: "bash -c 'cat ${HOME}/.bashrc'", cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(posixBracketHome.allowed).toBe(false);

    const posixTilde = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "posix-tilde",
        name: "run_command",
        args: { command: "bash -c 'cat ~/.bashrc'", cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(posixTilde.allowed).toBe(false);

    // PowerShell Join-Path env operands
    const pwshJoinEnv = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "pwsh-join-env",
        name: "run_command",
        args: { command: 'powershell -Command "Join-Path $env:WINDIR win.ini"', cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(pwshJoinEnv.allowed).toBe(false);

    const pwshJoinNamed = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "pwsh-join-named",
        name: "run_command",
        args: { command: 'powershell -Command "Join-Path -Path $env:USERPROFILE -ChildPath secret.txt"', cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(pwshJoinNamed.allowed).toBe(false);

    const pwshJoinProvider = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "pwsh-join-provider",
        name: "run_command",
        args: { command: 'powershell -Command "Join-Path env:WINDIR win.ini"', cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(pwshJoinProvider.allowed).toBe(false);

    // Dynamic command substitution: $() and backticks
    const pwshSubshell = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "pwsh-subshell",
        name: "run_command",
        args: { command: 'powershell -Command "Get-Content $(echo C:\\Windows\\win.ini)"', cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(pwshSubshell.allowed).toBe(false);
    expect(pwshSubshell.reason).toMatch(/Dynamic command substitution/);

    const bashBackticks = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "bash-backticks",
        name: "run_command",
        args: { command: 'bash -c "cat `echo /etc/passwd`"', cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(bashBackticks.allowed).toBe(false);
    expect(bashBackticks.reason).toMatch(/Dynamic command substitution/);

    // Fail-closed on undefined/unresolvable environment variables
    const undefinedVar = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "undef-var",
        name: "run_command",
        args: { command: 'powershell -Command "Get-Content $env:DEFINITELY_UNDEFINED_VAR_XYZ\\win.ini"', cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(undefinedVar.allowed).toBe(false);
    expect(undefinedVar.reason).toMatch(/unverified environment variable/);

    // Redirections with env vars
    const redirEnv = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "redir-env",
        name: "run_command",
        args: { command: "echo leak > %TEMP%\\leak.txt", cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(redirEnv.allowed).toBe(false);

    // Harmless commands without escape risk remain permitted
    const harmlessLs = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "harmless-ls",
        name: "run_command",
        args: { command: "ls", cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(harmlessLs.allowed).toBe(true);

    const harmlessGit = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "harmless-git",
        name: "run_command",
        args: { command: "git status", cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(harmlessGit.allowed).toBe(true);

    const harmlessGitDiff = validateToolCallAgainstFileScope(
      agentScope,
      {
        id: "harmless-diff",
        name: "run_command",
        args: { command: "git diff HEAD~1", cwd: agentCwd },
      },
      workspaceRoot
    );
    expect(harmlessGitDiff.allowed).toBe(true);
  });

  it("integrates with ToolExecutor.executeTools to block exact independent repros and env escapes", async () => {
    const { ToolExecutor } = await import("../src/core/agent/ToolExecutor.js");

    const events: any[] = [];
    const mockAgent: any = {
      fileScope: ["src/core/agent/**"],
      workingDirectory: workspaceRoot,
      worktreePath: workspaceRoot,
      getActiveTools: async () => [],
      onEvent: (ev: any) => events.push(ev),
    };

    // Repro 1 via ToolExecutor
    const resultsRepro1 = await ToolExecutor.executeTools(
      mockAgent,
      [
        {
          id: "exec-repro-1",
          name: "run_command",
          args: { command: 'powershell -Command "Get-Content $env:WINDIR\\win.ini"', cwd: "src/core/agent" },
        },
      ],
      [],
      [],
      false,
      "system prompt"
    );
    expect(resultsRepro1).toHaveLength(1);
    expect(resultsRepro1[0].isError).toBe(true);
    expect(resultsRepro1[0].result).toContain("Access denied by delegated fileScope");

    // Repro 2 via ToolExecutor
    const resultsRepro2 = await ToolExecutor.executeTools(
      mockAgent,
      [
        {
          id: "exec-repro-2",
          name: "run_command",
          args: { command: "cmd /c type %WINDIR%\\win.ini", cwd: "src/core/agent" },
        },
      ],
      [],
      [],
      false,
      "system prompt"
    );
    expect(resultsRepro2).toHaveLength(1);
    expect(resultsRepro2[0].isError).toBe(true);
    expect(resultsRepro2[0].result).toContain("Access denied by delegated fileScope");

    // %USERPROFILE% via ToolExecutor
    const resultsUserprofile = await ToolExecutor.executeTools(
      mockAgent,
      [
        {
          id: "exec-userprofile",
          name: "run_command",
          args: { command: "cmd /c type %USERPROFILE%\\secret.txt", cwd: "src/core/agent" },
        },
      ],
      [],
      [],
      false,
      "system prompt"
    );
    expect(resultsUserprofile).toHaveLength(1);
    expect(resultsUserprofile[0].isError).toBe(true);
    expect(resultsUserprofile[0].result).toContain("Access denied by delegated fileScope");

    // PowerShell Join-Path via ToolExecutor
    const resultsJoinPath = await ToolExecutor.executeTools(
      mockAgent,
      [
        {
          id: "exec-joinpath",
          name: "run_command",
          args: { command: 'powershell -Command "Join-Path $env:WINDIR win.ini"', cwd: "src/core/agent" },
        },
      ],
      [],
      [],
      false,
      "system prompt"
    );
    expect(resultsJoinPath).toHaveLength(1);
    expect(resultsJoinPath[0].isError).toBe(true);
    expect(resultsJoinPath[0].result).toContain("Access denied by delegated fileScope");

    // Dynamic command substitution via ToolExecutor
    const resultsSubst = await ToolExecutor.executeTools(
      mockAgent,
      [
        {
          id: "exec-subst",
          name: "run_command",
          args: { command: 'powershell -Command "Get-Content $(echo C:\\Windows\\win.ini)"', cwd: "src/core/agent" },
        },
      ],
      [],
      [],
      false,
      "system prompt"
    );
    expect(resultsSubst).toHaveLength(1);
    expect(resultsSubst[0].isError).toBe(true);
    expect(resultsSubst[0].result).toContain("Access denied by delegated fileScope");
    expect(resultsSubst[0].result).toContain("Dynamic command substitution");
  });
});
