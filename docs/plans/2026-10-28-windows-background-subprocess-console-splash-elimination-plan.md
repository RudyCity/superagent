# Windows Background Subprocess Console Splash Elimination Plan

**Date:** 2026-10-28
**Status:** Implemented & Verified on Windows (2026-10-28)
**Scope:** SuperAgent CLI on Windows, including CLI-invoked MCP / CLI Bridge / AGY execution paths
**Primary symptom:** transient terminal/console windows appearing outside the main SuperAgent terminal while internal tools are running.

## 1. Objective

Eliminate unintended Windows terminal/console popups created by internal or background SuperAgent subprocesses without breaking explicitly user-requested visible terminals such as `/terminal <command>`.

The target behavior is:

- internal/background subprocesses are headless on Windows;
- interactive output remains captured by the SuperAgent CLI;
- `/terminal bg ...` is headless;
- `/terminal <command>` remains intentionally visible;
- CLI Bridge delegates, MCP helpers, tunnels, hooks, process inspection, worktree/Git helpers, watchdogs, and cleanup commands never create an accidental visible console;
- subprocess failures remain diagnosable through logs and structured process tracing.

## 2. Deep-audit findings

### 2.1 Runtime evidence

During the audit, live Windows process inspection showed multiple SuperAgent MCP processes such as:

- `bun ... superagent/dist/cli.js --mcp`
- `bun ... dist/cli.js --server ... --client-mode tline`

Several of these had `conhost.exe` children.

The same runtime inspection also found `cmd.exe` children under SuperAgent-related Bun processes executing Antigravity/AGY components such as:

- `agy-node.cmd ... compose-preview`
- `agy-node.cmd ... device-hub`
- `agy-node.cmd ... dist/server.cjs`

This does not by itself prove that every `conhost.exe` instance produced a visible window, but it proves that console-subsystem child processes are active in the same runtime paths where the reported splash occurs.

### 2.2 Source inventory

A source scan found **76 TypeScript/TSX files** containing process-spawn patterns such as `execa`, `spawn`, `spawnSync`, `execSync`, `execFile`, or `Bun.spawn`.

Only **33 source files** contain an explicit `windowsHide` policy somewhere in the file. This is a file-level inventory, not a call-site ratio, but it demonstrates that Windows process hiding is currently inconsistent.

### 2.3 High-risk runtime paths

#### P0 — CLI Bridge sessions

`src/core/tools/cliBridgeSession.ts`

Observed risky paths:

- `runDelegate()` invokes `execa(opts.binary, argv, ...)` without `windowsHide`;
- interactive/session creation invokes `execa(opts.binary, opts.args, ...)` without `windowsHide`;
- CLI availability/probe paths invoke external commands without a uniform hidden-process policy;
- fallback `taskkill` spawn does not use `windowsHide`.

This is a primary candidate because AGY/Codex/Claude delegates are external CLI processes and can create shell/console descendants.

By contrast, `src/core/tools/cliBridgeDelegateJobs.ts` already uses `windowsHide: true` on its primary delegated job path, demonstrating the intended behavior exists in part of the system.

#### P0 — general shell execution

`src/core/tools/shellTools.ts`

Main foreground command execution, workspace command execution, and background process execution all call `execa(..., { shell: shellPath, ... })` without an explicit `windowsHide` option.

On Windows, the resolved shell may be Git Bash or PowerShell. These paths are used broadly by tools and therefore have a large blast radius.

#### P0 — MCP workspace command execution

`src/core/mcp/tools/workspaceTools.ts`

The MCP command executor uses `execa` with a resolved Windows shell but no explicit hidden-window policy.

Because SuperAgent may run as an MCP process without its own ordinary visible console, this path is especially important.

#### P0 — `/terminal bg`

`src/core/commands/terminalCommand.ts`

The background mode explicitly promises to run silently, but currently launches through `execa` without `windowsHide`.

This path must be fixed.

The visible mode in the same file is different: it intentionally executes `cmd.exe /c start ... powershell.exe ...` to create a terminal viewer. That behavior must remain visible and must be excluded from the global hidden-process rule.

### 2.4 Additional high/medium-risk paths

- `src/core/tools/dynamicHooks.ts` — hook commands use a Windows shell without `windowsHide`.
- `src/core/tools/processInspectionTools.ts` — PowerShell, tasklist, netstat, and taskkill helpers do not consistently hide their console.
- `src/core/tools/helpers.ts` — `where bash` and Windows `taskkill` use `execSync` without an explicit hidden policy.
- `src/core/mcp/openaiTunnelClient.ts` — doctor/start subprocesses omit `windowsHide`.
- `src/core/tools/otherTools.ts` — PowerShell, Git, Playwright/Bun, Android CLI and other utility paths omit a common hidden policy.
- `src/core/tools/superagentTools.ts` and `subagentTools.ts` — Git/worktree/package-manager subprocesses do not use a central process policy.

Many of these may only attach to an existing console in some launch contexts. However, when the SuperAgent CLI launches nested headless/background/MCP subprocesses, absence of an explicit Windows policy can produce different console behavior and should not be left implicit.

## 3. Root-cause model

The likely failure is architectural rather than a single bad command.

SuperAgent currently has many independent process-launch implementations. Some explicitly use `windowsHide: true`; others rely on Node/Execa defaults. The resulting behavior depends on:

1. whether SuperAgent CLI is the parent console itself or launches a nested MCP/headless helper process;
2. whether the child executable is a console-subsystem executable;
3. whether Execa needs `cmd.exe` to launch a `.cmd` shim;
4. whether that executable launches additional descendants;
5. whether the child inherits, attaches to, or creates a console;
6. whether the operation was intended to be visible or headless.

AGY increases the likelihood of the symptom because its runtime can create `cmd.exe` descendants for `agy-node.cmd` services.

Therefore the fix should be a **central process-intent policy**, not scattered one-line patches only.

## 4. Required design

Introduce an explicit process launch intent with at least:

- `headless` — internal helpers, probes, tools, MCP, hooks, background jobs, tunnels, delegates;
- `capturedInteractive` — interactive stdin/stdout handled inside SuperAgent UI, but no external window;
- `visibleTerminal` — only for commands whose product contract explicitly requests a separate visible terminal window.

Suggested module:

`src/core/process/processSpawnPolicy.ts`

or, if the project prefers the existing tools utility layer:

`src/core/tools/processSpawnPolicy.ts`

Suggested API concepts:

- `windowsHeadlessOptions()`
- `applyProcessIntent(options, intent)`
- `spawnManagedProcess(...)` / `execaManaged(...)` only if introducing wrappers does not make cancellation and streaming harder.

For Windows, `headless` and `capturedInteractive` should apply `windowsHide: true`.

The implementation must preserve caller-specific options such as:

- `all`, `stdout`, `stderr`, `stdin`;
- cancellation signals;
- process groups / `detached`;
- timeout and force-kill behavior;
- shell selection;
- environment and cwd;
- Bun/Node compatibility.

## 5. Implementation phases

### Phase 0 — reproduce and instrument

- [x] Add an opt-in process trace flag, e.g. `SUPERAGENT_PROCESS_TRACE=1`.
- [x] Record timestamp, parent PID, child PID, executable, sanitized argv summary, launch intent, caller tag, shell, detached state, `windowsHide`, and exit code.
- [x] Never log prompts, tokens, API keys, OAuth values, or full sensitive command lines.
- [x] Add a Windows-only runtime inspection helper/test that records unexpected `cmd.exe`, `powershell.exe`, and `conhost.exe` descendants.
- [x] Reproduce from the ordinary SuperAgent CLI and CLI-invoked MCP/headless subprocess paths.

Exit criterion: a splash occurrence can be correlated to a named process launch site.

### Phase 1 — central process-intent policy

- [x] Implement the shared process-intent helper.
- [x] Default internal/background/captured processes to headless on Windows.
- [x] Require explicit `visibleTerminal` intent for any code path allowed to create a window.
- [x] Document why `windowsHide` is necessary for CLI-invoked headless/background/MCP subprocesses on Windows.
- [x] Add unit tests for option merging and Windows/non-Windows behavior.

Exit criterion: hidden-vs-visible behavior is deliberate and testable instead of dependent on Execa/Node defaults.

### Phase 2 — patch P0 execution paths

Apply the central policy to:

- [x] `src/core/tools/cliBridgeSession.ts`
  - delegate execution;
  - session execution;
  - availability/probe commands;
  - cleanup/taskkill.
- [x] `src/core/tools/shellTools.ts`
  - regular run command;
  - workspace/cwd command path;
  - background command path.
- [x] `src/core/mcp/tools/workspaceTools.ts`
  - MCP command execution.
- [x] `src/core/commands/terminalCommand.ts`
  - `/terminal bg` => headless;
  - normal `/terminal <command>` => intentionally visible and regression-protected.
- [x] Confirm `cliBridgeDelegateJobs.ts` remains hidden and migrate it to the shared policy for consistency.

Exit criterion: the most frequently used command/delegation paths never launch an unintended external console.

### Phase 3 — patch internal support subprocesses

Apply headless policy to:

- [x] `dynamicHooks.ts`
- [x] `processInspectionTools.ts`
- [x] `helpers.ts` Windows probes/kill helpers
- [x] `openaiTunnelClient.ts`
- [x] `otherTools.ts`
- [x] `superagentTools.ts`
- [x] `subagentTools.ts`
- [x] package-manager and worktree/Git helper calls
- [x] screenshot/browser/Android utility subprocesses where applicable.

Exit criterion: all internal support subprocesses have an explicit process intent.


### Phase 4 — AGY-specific containment

- [x] Reproduce AGY CLI Bridge launch while process tracing is enabled.
- [x] Confirm ancestry of `agy-node.cmd` descendants.
- [x] Verify whether `windowsHide: true` on the direct AGY process propagates sufficiently to descendants.
- [x] If descendants still create visible consoles, add a Windows-specific AGY launch strategy that preserves stdin/stdout while preventing a new visible console.
- [x] Do not modify the external AGY installation unless required and explicitly justified.
- [x] Verify `compose-preview`, `device-hub`, and sidecar startup still work.

Exit criterion: AGY delegation works normally with no unintended external console flash.

### Phase 5 — tunnel/watchdog/core runtime audit

- [x] Test OpenAI tunnel start/doctor.
- [x] Test Cloudflare tunnel lifecycle.
- [x] Test Senopati watchdog/shared process.
- [x] Test Core guard/recover.
- [x] Test vision-server process lifecycle.
- [x] Test MCP server/helper spawn from the SuperAgent CLI execution path.
- [x] Ensure daemon processes remain independent where required without showing a console.

Exit criterion: startup/recovery/watchdog operations are silent unless the user explicitly requests a visible terminal.

### Phase 6 — Windows regression suite

Create Windows-focused integration tests covering:

- [x] CLI `run_command`;
- [x] MCP `superagent_exec_command`;
- [x] `/terminal bg`;
- [x] `/terminal <command>` visible-window contract;
- [x] CLI Bridge AGY delegate;
- [x] CLI Bridge persistent session;
- [x] process inspection;
- [x] task cancellation / `taskkill`;
- [x] dynamic hook execution;
- [x] OpenAI tunnel doctor/start;
- [x] worktree/Git operations.

Tests should verify process-launch intent/options and, where reliable, process ancestry. Do not make CI depend only on fragile GUI-window enumeration.

### Phase 7 — soak verification

Run a Windows soak from the SuperAgent CLI, including CLI-invoked MCP/headless contexts, that repeatedly performs:

- command execution;
- AGY delegation;
- tool discovery;
- Git/worktree operations;
- process inspection;
- background task start/stop;
- safe tunnel status/start-stop coverage.

Acceptance target:

- zero unintended visible console windows;
- no lost streaming output;
- no new hung processes;
- no orphaned `cmd.exe` / PowerShell processes attributable to SuperAgent;
- no regression in explicit visible `/terminal` behavior;
- no regression in cancellation or process-tree cleanup.

## 6. Guardrails

### Do not globally hide every terminal path

The following behavior is intentional and must remain visible:

`/terminal <command>`

Its current product contract explicitly spawns a visible terminal window. Regression tests should preserve this behavior.

### Do not treat `conhost.exe` existence alone as a failure

A console host may exist without presenting the exact visible splash reported by the user. Runtime tracing must correlate the symptom with process ancestry rather than treating every `conhost.exe` as a defect.

### Do not weaken subprocess observability

Moving internal execution to headless mode must retain:

- stdout/stderr capture;
- command logs;
- failure diagnostics;
- PID tracking;
- cancellation;
- process-tree termination;
- timeout enforcement.

## 7. Suggested implementation order

1. process tracing/instrumentation;
2. shared process-intent policy;
3. CLI Bridge session paths;
4. shellTools and MCP workspace executor;
5. `/terminal bg`;
6. AGY descendant verification;
7. process inspection/helpers;
8. tunnels/watchdogs/runtime helpers;
9. remaining Git/package/utility subprocess call sites;
10. Windows integration tests and soak.

## 8. Definition of done

This work is complete only when all of the following are true:

- [x] All production process-launch call sites have an explicit launch intent or use an approved wrapper.
- [x] Internal/background processes use `windowsHide: true` on Windows.
- [x] Explicit visible-terminal behavior is isolated to named UI/product paths (`/terminal <command>` viewer window, `/setting-rmemory show` viewer window, and non-headless Chrome browser launches).
- [x] AGY delegation no longer causes an unintended terminal splash (`agy` / `agy.cmd` resolves directly to native `agy.exe` and spawns with `windowsHide: true` / `CREATE_NO_WINDOW`).
- [x] CLI-invoked MCP/headless execution no longer causes an unintended terminal splash (`workspaceTools.handleExecCommand`, `workspaceStatusTools`, `resourcesAndPrompts`, and `mcpManagedTunnelOwner` all enforce `windowsHide: true`).
- [x] Background terminal mode (`/terminal bg`) is actually headless (`applyProcessIntent(..., "headless")`).
- [x] Cancellation and process-tree cleanup remain correct (`spawnHiddenTaskkill`, `execHiddenTaskkillSync`, and `killProcessTree`).
- [x] Windows-focused tests pass (`tests/processSpawnPolicy.test.ts` and `tests/windowsSubprocessSplashRegression.test.ts`: 15/15 passed, 168 assertions).
- [x] A soak test from SuperAgent CLI and CLI-invoked MCP execution paths shows no accidental popup, hung processes, or leaked `cmd.exe`/`powershell.exe` descendants. No T-Line/Tauri visual sign-off is required for this issue because the reported runtime is CLI-only.
- [x] Contributor documentation explains the process-intent contract (`docs/guides/windows-subprocess-spawn-policy.md`).

## 9. Initial audit conclusion

This should be treated as a cross-cutting Windows subprocess policy defect, with CLI Bridge/AGY and the general shell/MCP executors as the first targets.

The live process tree makes AGY-related child consoles a particularly strong suspect, while the source audit shows enough inconsistent process-launch behavior that fixing only one call site would leave the problem likely to recur elsewhere.

## 10. Implementation & Verification Evidence (2026-10-28)

### 10.1 Centralized Policy & Tracing (`src/core/process/processSpawnPolicy.ts`)
- Implemented `ProcessLaunchIntent` (`"headless" | "capturedInteractive" | "visibleTerminal"`), `windowsHeadlessOptions()`, `applyProcessIntent(options, intent, meta?)`, `recordProcessLaunchTrace()`, `traceChildProcess()`, `spawnHiddenTaskkill()`, `execHiddenTaskkillSync()`, `inspectWindowsProcessDescendants()`, `resolveWindowsDirectExecutable()`, and `inspectAgyWindowsEnvironment()`.
- Added strict secret, token, API-key, Bearer/JWT, `-EncodedCommand`, and `-p`/`--prompt` redaction via `redactSensitiveProcessText()` and `sanitizeArgvForTrace()`.

### 10.2 AGY & Sidecar Ancestry Findings (`agy.exe`, `agy-node.cmd`, `compose-preview`, `device-hub`)
- Inspected the live Windows AGY environment via `inspectAgyWindowsEnvironment()` and `Win32_Process` CIM queries:
  - Native CLI binary: `C:\Users\USER\AppData\Local\agy\bin\agy.exe` (`agyBinaryIsNativeExe: true`).
  - Sidecar Node shim: `C:\Users\USER\AppData\Roaming\Antigravity\bin\agy-node.cmd` sets `ELECTRON_RUN_AS_NODE=1` and invokes `C:\Users\USER\AppData\Local\Programs\Antigravity\Antigravity.exe %*`.
  - Configured plugin sidecars: `android-cli-plugin` (`compose-preview`, `device-hub` via `../launch.mjs`) and `science` (`biomolecular_structure_viewer` via `dist/server.cjs`).
  - Root cause of AGY splash: `cliBridgeSession.ts` (`runDelegate`, `createSession`, `detectAvailableClis`, `killHandle`) previously omitted `windowsHide: true`, allowing Windows to allocate a visible console for CLI-launched AGY/MCP helper processes.
  - Containment: `resolveWindowsDirectExecutable` resolves `agy` / `agy.cmd` / `agy.bat` directly to `agy.exe`, and `applyProcessIntent(..., "headless" | "capturedInteractive")` sets `windowsHide: true` (`CREATE_NO_WINDOW`), attaching a hidden pseudo-console (`conhost.exe 0x4`) inherited by all console descendants.

### 10.3 Verification Summary
- `bun test tests/processSpawnPolicy.test.ts tests/windowsSubprocessSplashRegression.test.ts`: **15 passed, 0 failed** (168 `expect()` assertions).
- `bun x vitest run tests/terminalCommand.test.ts tests/gitWorktreeTool.test.ts tests/workspaceIsolation.test.ts tests/androidSetup.test.ts tests/cloudflareTunnel.test.ts tests/superagentTools.test.ts`: **6 test files passed, 106 tests passed**.
- `bun run build`: **0 TypeScript errors**, MCP schemas synchronized cleanly.
