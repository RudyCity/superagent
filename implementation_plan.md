# Implementation Plan: 2026-10-28 Post-Audit Core Remediation

Following the independent post-AGY audit (`docs/audits/2026-10-28-post-agy-independent-reaudit.md`), this plan implements the remaining verified Core defects:
1. **P0 DEEP-02**: Delegated `fileScope` shell escape (absolute paths, redirection, file operations, cmd/pwsh/sh, script invocation, nested shells).
2. **P1 DEEP-04**: Classifier progress isolation wired through production preprocessing (`RequestProcessor` -> `classifyRequest` -> model loading).
3. **P2 NEW-01**: Concurrency limiter waiter hygiene (remove expired timeout waiters, eliminate stale queue growth).
4. **P1/P2 DEEP-07**: No-progress helper completeness (wire `isRepetitiveNarration` into `LoopIterationProcessor`).

## Detailed Technical Design

### 1. P0 DEEP-02: Delegated fileScope Shell Boundary
- File: `src/core/agent/fileScopeGuard.ts`
- Enhance `validateToolCallAgainstFileScope`:
  - Support all shell tool names: `bash`, `run_command`, `run_background_process`, `shell`, `exec`, `terminal`, `cmd`, `sh`, `superagent_exec_command`, `superagent_office_cli`.
  - Validate effective cwd:
    - If `args.cwd` is provided, resolve and verify within `fileScope`.
    - If `args.cwd` is omitted, resolve against workspaceRoot.
  - Fail-closed on obfuscated/encoded commands:
    - Check for `-(?:e|enc|encodedcommand)\b` in PowerShell/pwsh invocations.
  - Recursively unpack nested shells:
    - `bash -c "..."`, `sh -c "..."`, `cmd /c "..."`, `powershell -Command "..."`, `eval "..."`.
  - Directory changes:
    - `cd`, `chdir`, `pushd`, `Set-Location`, `sl`. Verify target directory is within `fileScope`.
  - Shell redirections:
    - `>` , `>>`, `<`, `2>`, `&>`, PowerShell `| Out-File`, `| Set-Content`, `| Add-Content`, `| tee`.
    - Allow standard null sinks (`/dev/null`, `nul`, `&1`, `&2`); verify all file targets against `fileScope`.
  - Path extraction across platforms:
    - Windows absolute paths: `C:\...`, `D:/...`, quoted `"D:\..."`, UNC `\\...`.
    - MSYS2 / Git Bash paths: `/c/...`, `/d/...`.
    - Unix absolute paths: `/[a-zA-Z0-9_\-\.\/]+` (filtered for Windows flags).
    - Traversal tokens: `..`.
    - File manipulation command arguments (`cat`, `type`, `Get-Content`, `cp`, `mv`, `rm`, etc.).
    - Script arguments for `node`, `python`, `powershell`, `bash`, `sh`.
  - Enforce realpath symlink/reparse checks on all resolved paths via `canonicalizeTarget`.
- Tests:
  - Direct probe: `fileScope = ['src/core/agent/**']`, `cwd = 'src/core/agent'`, command referencing absolute workspace root `package.json` -> must return `{ allowed: false }`.
  - Shell variants: cmd `type`, PowerShell `Get-Content`, POSIX `cat`.
  - Redirections (`>`, `>>`).
  - Script executions (`node <outside>`).
  - Integration test through `ToolExecutor.executeTools`.

### 2. P1 DEEP-04: Classifier Progress Isolation
- Files: `src/core/agent.ts`, `src/core/agent/RequestProcessor.ts`, `src/core/requestClassifier.ts`, `src/core/tools/state.ts`
- Changes:
  - In `src/core/agent.ts`:
    - Wrap `RequestProcessor.processRequest(this, userInput)` with `agentLocalStorage.run(this, ...)` and `runWithProgressCallback((ev) => this.onEvent(ev), ...)`.
  - In `src/core/agent/RequestProcessor.ts`:
    - Pass `onProgress: (event: any) => agent.onEvent(event)` into `classifyRequest(userInput, classifierModel, { ..., onProgress: ... })`.
  - In `src/core/requestClassifier.ts`:
    - In `classifyRequest`: fallback to `getProgressCallback()` if `options?.onProgress` is not explicitly passed.
    - Pass `progressCb` into `classifyWithSenopatiONNX(text, undefined, progressCb)`.
    - In `getSenopatiSession`: fallback to `getProgressCallback()` if `onProgress` is not provided.
- Tests:
  - Concurrent `RequestProcessor.processRequest` calls for two agents with separate event collectors; assert zero cross-contamination.

### 3. P2 NEW-01: Concurrency Waiter Hygiene
- File: `src/core/rateLimiter.ts`
- Changes:
  - In `SharedConcurrencyLimiter.acquire`:
    - Implement cancellable waiter callback.
    - When the 100ms timeout fires, splice the waiter callback out of `this.processQueue`.
    - When `release()` pops and invokes `next()`, ensure the waiter is removed and the timer is cleared.
  - Expose `getQueueLength(): number` for diagnostic/testing purposes.
- Tests:
  - Test sustained contention with multiple waiting promises; assert `processQueue.length` remains bounded by active waiter count (does not grow over time) and all slots are acquired cleanly without lost wakeups.

### 4. P1/P2 DEEP-07: No-Progress Helper Completeness
- Files: `src/core/agent/LoopIterationProcessor.ts`, `tests/checklistContinuationGuard.test.ts`
- Changes:
  - In `LoopIterationProcessor.ts`:
    - Collect previous assistant message contents from conversation.
    - Import and call `isRepetitiveNarration(textContent, previousAssistantTexts)`.
    - Suppress action/planning continuation nudge if repetitive narration is detected.
    - In checklist enforcement, stop auto-continuation if repetitive narration is detected.
- Tests:
  - Test verifying repetitive assistant text halts continuation nudges.

## Verification
- Run `bun run build`.
- Run focused and regression test suites with `bun test`.
- Verify the direct independent probe returns `{ allowed: false }`.
