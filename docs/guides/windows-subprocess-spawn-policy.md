# Windows Subprocess Spawn Policy & Console-Splash Prevention

## Overview

When SuperAgent runs under a GUI host (`T-Line` Tauri desktop app), as an MCP server (`superagent --mcp` or `superagent mcp tunnel-owner`), or as a headless background service on Windows, the parent process has **no attached Win32 console**.

On Windows, spawning any console-subsystem binary (`cmd.exe`, `powershell.exe`, `where.exe`, `taskkill.exe`, `git.exe`, `bun.exe`, `node.exe`, `agy.exe`, `python.exe`, `rg.exe`, `cloudflared.exe`) without `CREATE_NO_WINDOW` (`windowsHide: true` in Node.js / `execa`) instructs the OS to allocate a new `conhost.exe` / Windows Terminal window, causing an intrusive terminal "splash" or flash on the user's desktop.

Conversely, when a console process **is** spawned with `windowsHide: true` (`CREATE_NO_WINDOW`), Windows attaches a hidden pseudo-console (`conhost.exe 0x4`) to the child process, and all console descendants spawned by that child inherit the hidden console rather than opening new visible windows.

---

## Centralized Process Spawn Policy (`src/core/process/processSpawnPolicy.ts`)

All subprocess creation in SuperAgent must declare an explicit `ProcessLaunchIntent` or use the centralized helpers in [`src/core/process/processSpawnPolicy.ts`](../../src/core/process/processSpawnPolicy.ts).

### Launch Intents (`ProcessLaunchIntent`)

| Intent | `windowsHide` | Use Cases |
|--------|---------------|-----------|
| `"headless"` | `true` | Default for all internal tools (`bash`, `run_command`, `run_background_process`), MCP `superagent_exec_command`, `/terminal bg`, one-shot CLI Bridge delegations (`runDelegate`, `launchDelegateJob`), dynamic hooks, Git/worktree operations, port/process inspection, tunnels, OCR/Vision servers, and binary probes. |
| `"capturedInteractive"` | `true` | Persistent multi-turn interactive CLI Bridge sessions (`createSession`) whose `stdin`/`stdout`/`stderr` streams are piped and managed programmatically without a separate OS terminal window. |
| `"visibleTerminal"` | `false` | Strictly reserved for explicit user-requested visible windows: foreground `/terminal <command>` viewer window (`src/core/commands/terminalCommand.ts`), `/setting-rmemory show` viewer window (`src/core/commands/settingsCommand.ts`), and non-headless Chrome browser launches (`src/core/tools/chromeBrowserTools.ts`). |

---

## Approved APIs

### 1. `applyProcessIntent(options, intent, meta?)`

Merges caller `execa` / `child_process` options with the `windowsHide` setting required by `intent` without mutating the input object or stripping `all`, `stdout`, `stderr`, `stdin`, `cancelSignal`, `timeout`, `forceKillAfterDelay`, `detached`, `shell`, or `env`:

```ts
import { execa } from "execa";
import { applyProcessIntent, traceChildProcess } from "../process/processSpawnPolicy.js";

const opts = applyProcessIntent(
  {
    cwd,
    all: true,
    reject: false,
    timeout: 30_000,
  },
  "headless",
  { caller: "myModule.runCheck", executable: "git", args: ["status", "--short"], cwd }
);

const child = traceChildProcess(execa("git", ["status", "--short"], opts), {
  caller: "myModule.runCheck",
  executable: "git",
  args: ["status", "--short"],
  cwd,
  intent: "headless",
  options: opts,
});
```

### 2. `spawnHiddenTaskkill(pid, tree?, caller?)` & `execHiddenTaskkillSync(pid, tree?, timeoutMs?, caller?)`

Never call raw `spawn("taskkill", ...)` or `execSync("taskkill ...")` without `windowsHide: true`. Always use `spawnHiddenTaskkill` or `execHiddenTaskkillSync` so process-tree termination never flashes a `taskkill.exe` window.

### 3. `resolveWindowsDirectExecutable(binary, env?)`

On Windows, invoking a `.cmd` or `.bat` shim causes `execa`/`cross-spawn` to wrap the call in `cmd.exe /d /s /c`. When a native `.exe` binary is installed (such as `%LOCALAPPDATA%\agy\bin\agy.exe`), `resolveWindowsDirectExecutable` resolves `agy`, `agy.cmd`, and `agy.bat` directly to `agy.exe`, avoiding unnecessary `cmd.exe` intermediaries.

---

## Opt-In Process Launch Tracing (`SUPERAGENT_PROCESS_TRACE=1`)

To diagnose subprocess launches without leaking secrets or user prompts:

- Set `SUPERAGENT_PROCESS_TRACE=1` (and optionally `SUPERAGENT_PROCESS_TRACE_FILE=/path/to/trace.jsonl`).
- Every traced process records `spawn` and `exit` events containing:
  - `timestamp`, `parentPid`, `childPid`, `executable`, `argvSummary`
  - `intent`, `caller`, `cwd`, `shell`, `detached`, `windowsHide`
  - `exitCode`, `signal`, `durationMs`
- **Automatic Redaction**:
  - Prompt flags (`-p`, `--prompt`, `--system-prompt`) have their values replaced with `[REDACTED_PROMPT len=...]`.
  - Encoded commands (`-EncodedCommand`, `-enc`, `-e`) are replaced with `[REDACTED_ENCODED len=...]`.
  - API keys (`sk-...`, `ghp_...`, `AIza...`, `xoxb-...`), Bearer tokens, JWTs, and secret assignments (`API_KEY=...`, `TOKEN=...`, `PASSWORD=...`) are scrubbed via `redactSensitiveProcessText()`.

---

## Contributor Checklist for New Subprocess Call Sites

1. **Never** call `execa(...)`, `spawn(...)`, `exec(...)`, `execSync(...)`, `execFile(...)`, `execFileSync(...)`, or `fork(...)` without `applyProcessIntent(..., "headless")` or explicit `windowsHide: true`.
2. **Never** change foreground `/terminal <command>` to headless — its detached PowerShell viewer window is an intentional product feature (`"visibleTerminal"`), while `/terminal bg <command>` and the background command runner must remain `"headless"` (`windowsHide: true`).
3. Run `bun test tests/processSpawnPolicy.test.ts tests/windowsSubprocessSplashRegression.test.ts` before completing any PR that adds or modifies subprocess execution.
