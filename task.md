# Tasks: 2026-10-28 Post-Audit Core Remediation

- [x] P0: Delegated fileScope environment-variable expansion escape remediation
  - [x] Identify root cause in `fileScopeGuard.ts` for shell environment-variable expansions
  - [x] Implement fail-closed environment-variable expansion, inspection, and rejection
  - [x] Support PowerShell `$env:VAR`, `${env:VAR}`, `Join-Path` env operands
  - [x] Support cmd `%VAR%` and `!VAR!`
  - [x] Support POSIX `$HOME`, `${VAR}`, and `~` tilde expansion
  - [x] Fail closed on dynamic command substitution (`$()`, `` `...` ``)
  - [x] Cover quoted and unquoted forms in nested shells, file ops, redirections, and script executions
  - [x] Preserve harmless commands without filesystem escapes
  - [x] Add adversarial regression tests in `tests/fileScopeHardEnforcement.test.ts` (including ToolExecutor integration and exact repros)
  - [x] Verify both independent repros return `allowed: false`
  - [x] Run full focused regression suite and `bun run build`
  - [x] Update `walkthrough.md` and commit/push changes

- [x] P0 (DEEP-02): Delegated fileScope shell escape remediation
  - [x] Implement platform-aware shell command validator in `src/core/agent/fileScopeGuard.ts` (cmd.exe, PowerShell, POSIX)
  - [x] Enforce effective cwd within fileScope
  - [x] Detect absolute paths outside scope (Windows drive paths, Git Bash `/c/`, UNC, Unix absolute)
  - [x] Intercept redirection operators (`>`, `>>`, `<`, `2>`, `Out-File`, `Set-Content`, `tee`)
  - [x] Intercept file manipulation commands (`cat`, `type`, `Get-Content`, `Set-Content`, `cp`, `mv`, `del`, `rm`)
  - [x] Intercept script invocations (`node`, `python`, `powershell`, `bash`, `sh`) and executable paths
  - [x] Detect and fail closed on uninspectable encoded commands (`-enc`, `-EncodedCommand`)
  - [x] Unpack and recursively validate nested shell invocations (`bash -c`, `cmd /c`, `powershell -c`)
  - [x] Add regression tests in `tests/fileScopeHardEnforcement.test.ts` including direct independent probe and ToolExecutor integration
- [x] P1 (DEEP-04): Classifier progress isolation wired through production preprocessing
  - [x] Wrap `RequestProcessor.processRequest` in `agentLocalStorage.run` and `runWithProgressCallback` in `src/core/agent.ts`
  - [x] Pass `onProgress: (ev) => agent.onEvent(ev)` from `RequestProcessor.processRequest` to `classifyRequest` in `src/core/agent/RequestProcessor.ts`
  - [x] Wire `onProgress` fallback via `getProgressCallback()` in `src/core/requestClassifier.ts` (`classifyRequest`, `classifyWithSenopatiONNX`, `getSenopatiSession`)
  - [x] Add regression test in `tests/classifierProgressIsolation.test.ts` testing concurrent real `RequestProcessor.processRequest`
- [x] P2 (NEW-01): Concurrency waiter hygiene in SharedConcurrencyLimiter
  - [x] Update `SharedConcurrencyLimiter.acquire` in `src/core/rateLimiter.ts` to remove expired waiters on timeout
  - [x] Ensure `release()` pops and wakes active waiters without accumulating stale callbacks
  - [x] Add regression tests in `tests/concurrencyLimiterSafeOwnership.test.ts` asserting bounded waiter queue length under contention and no lost wakeups
- [x] P1/P2 (DEEP-07): No-progress helper completeness (wire `isRepetitiveNarration`)
  - [x] Wire `isRepetitiveNarration` into `src/core/agent/LoopIterationProcessor.ts`
  - [x] Suppress planning nudge and break checklist continuation on repetitive text narration
  - [x] Add regression tests in `tests/checklistContinuationGuard.test.ts`
- [x] Verification, full test suite run with Bun, and documentation
  - [x] Run `bun run build`
  - [x] Run 90 focused tests + new regression tests
  - [x] Verify direct adversarial probe
  - [x] Update `walkthrough.md`
  - [x] Git commit and push only modified files


---

## Milestone M1 — Reliable Parallel Capacity

- [x] **M1.1** Inspect occupied slots using process birth identity
  - [x] Query capacity directory `superagent-cli-bridge-capacity-v1`
  - [x] Correlate slot leases with OS process identity (Win32_Process CreationDate ticks)
  - [x] Determine ownership and liveness of active processes and child CLIs
- [x] **M1.2** Implement fail-closed stale-slot classifier
  - [x] Define `CapacitySlotState` (6 states: `active_verified`, `owner_alive_child_alive`, `owner_dead_child_alive_review_required`, `owner_dead_child_dead_recoverable`, `identity_mismatch_blocked`, `corrupt_blocked`)
  - [x] Implement `classifyCapacitySlot` in `src/core/tools/cliBridgeRecovery.ts`
  - [x] Ensure fail-closed evaluation on PID reuse, unknown PID, or corrupt metadata
- [x] **M1.3** Implement safe orphan-slot recovery
  - [x] Extend slot metadata with `ownerProcessIdentity`, `childPid`, `childProcessIdentity`, `heartbeatAt` in `src/core/tools/cliBridgeCapacity.ts`
  - [x] Implement `inspectCapacitySlot`, `listDetailedCapacitySlots`, and `recoverProvenOrphanSlot`
  - [x] Add `delegate.slots` and `delegate.recover-slot` actions in `src/core/tools/cliBridgeTool.ts`
  - [x] Add optional automatic recovery in `acquireCliBridgeCapacity` strictly for proven orphans
- [x] **M1.4** Add regression tests in `tests/cliBridgeCapacityRecovery.test.ts`
  - [x] Test PID reuse detection (returns `identity_mismatch_blocked`, blocks recovery)
  - [x] Test live owner protection (returns `owner_alive_child_alive`/`active_verified`, blocks theft/recovery)
  - [x] Test orphan recovery (returns `owner_dead_child_dead_recoverable`, successfully recovers slot)
  - [x] Test dead owner with surviving child (returns `owner_dead_child_alive_review_required`, protects child)
  - [x] Test terminal-job stale lease cleanup (recovers lingering lease when owner and child are dead)
  - [x] Test corrupt/malformed metadata fail-closed behavior
  - [x] Test `delegate.slots` and `delegate.recover-slot` tool actions
- [x] **M1.5** Recover only slots proven orphaned on host
  - [x] Audit live host slots (Slots 0 and 1 active_verified, Slots 2 and 3 available)
  - [x] Protect live owners and children; confirm zero active processes killed or stolen
- [x] **M1.6** Run 4 simultaneous read-only probes
  - [x] Concurrently dispatch 4 real AGY background jobs (`--mode plan`)
  - [x] Verify distinct capacity slots 0, 1, 2, 3 and distinct PIDs (44176, 42932, 5368, 43288)
  - [x] Verify concurrent `active_verified` state, exit code 0, and clean lease release
- [x] **M1.7** Prove four real AGY CLI Bridge coding delegates run in four isolated Git worktrees
  - [x] Worktree primitive: four distinct worktrees/branches can be created concurrently
  - [x] Automatic `worktree: true` integration creates isolated worktrees for delegates
  - [x] Replace the current fake "real AGY" E2E (`binary: "echo"`) with four actual AGY coding jobs
  - [x] Resolve same-project quota conflict: worker #4 is supported via `perProjectQuota = 4`
  - [x] Record real AGY artifact/commit provenance with zero main-workspace mutation
- [x] **M1.8** Verification, build, and documentation
  - [x] Independent M1 audit: 114 passed, 0 failed across 8 CLI Bridge suites (502 assertions)
  - [x] Reproduced focused remediation suite: 47 passed, 0 failed, 282 assertions
  - [x] SuperAgent `bun run build` passes
  - [x] Second independent re-audit recorded in `docs/audits/2026-10-28-cli-bridge-multi-agent-runtime-second-independent-reaudit.md`

---

## Milestone M2 — Adaptive Scheduler & Dynamic 2–8 Capacity

- [x] **M2.1** Resource sampler primitive exists and is unit-tested
- [x] **M2.2** Wire adaptive 2–8 capacity into `startDelegateJob()`
  - [x] Real delegate admission dynamically evaluates CPU/memory pressure
  - [x] Critical pressure contraction is implemented
  - [x] Enforce the requested hard upper bound of 8; `MAX_JOBS=12` strictly yields `effectiveSlots <= 8`
  - [x] Make orchestration feed/dashboard consume the same live scheduler context
- [x] **M2.3** Wire admission quotas and fair priority queue into the actual runtime
  - [x] Admission, quota, priority, fairness, and disk persistence are wired
  - [x] Queue drains when an active job completes
  - [x] Restored queue self-drains after restart on an idle host (S5 verified in `tests/cliBridgeAdaptiveScheduler.test.ts`)
  - [x] Reconcile per-project quota with required four-worker same-project concurrency

---

## Milestone M3 — Worktree Isolation, Resource Claims & Completion Contracts

- [x] **M3.1** Integrate worktree manager and safe host-wide resource claims into real delegates
  - [x] Worktree lifecycle primitive exists and passes direct Git tests
  - [x] Worktree manager is invoked directly by `delegate.start` when `worktree: true`
  - [x] Replaced TOCTOU claims with `.claim_mutex` atomic file open (`wx` flag) + `write.lock` in `cliBridgeResourceClaims.ts`
  - [x] Simultaneous-writer stress test in `tests/cliBridgeResourceClaimsStress.test.ts` proves **0 double-writer wins** across 40 iterations
  - [x] Resource claims are acquired upon job launch and released on job completion
- [x] **M3.2** Wire verified completion contracts into real delegates
  - [x] `AcceptanceContract` verifier primitive works when called directly
  - [x] `cliBridgeAcceptance.ts` is invoked by `finishJob()` in `cliBridgeDelegateJobs.ts`
  - [x] Public MCP/CLI Bridge schema exposes `acceptanceContract` in `cliBridgeTool.ts`
  - [x] Real completion states map to `verified`, `verification_failed`, and `succeeded_unverified`

---

## Milestone M4 — Agent Profiles & Durable DAG Orchestration

- [x] **M4.1** Wire role profiles into actual delegate/orchestration dispatch
  - [x] Role profiles are consumed by source runtime dispatch
  - [x] Source tool schema includes `role.list`
  - [x] Public MCP tool schema updated in `superagentMcpServer.ts` with `role.list`, `dag.*`, `priority`, `resourceClass`, `worktree`, and `acceptanceContract`
- [x] **M4.2** Implement durable executable DAG orchestration
  - [x] Atomic DAG persistence exists
  - [x] `executeDagGraph()` dispatches real AGY; independent one-node AGY probe returned `AUDIT_OK`
  - [x] Preserve `completionState: unverified` -> DAG `verificationState: succeeded_unverified` (`worker_succeeded != verified`)
  - [x] Add startup recovery/resume policy for persisted running DAGs (`reconcileRunningDagsOnStartup`)
  - [x] Enforce workspace authorization on DAG cancel
- [x] **M4.3** Implement real reviewer/consensus/speculative execution
  - [x] Workflows now spawn real delegate jobs in source
  - [x] Real two-reviewer consensus returns substantive verdicts
  - [x] Cancel all reviewer/candidate jobs when workflow deadline expires (timeout cleanup verified)
  - [x] Strengthen E2E assertions to require a real verified winner/verdict instead of merely defined result objects

---

## Milestone M5 — Crash Reconciliation, Isolation & Adapter Contracts

- [x] **M5.1** Wire crash reconciliation/checkpoints into CLI Bridge initialization
  - [x] Checkpoint/reconciliation helper is wired into initialization
  - [x] Checkpoint writes are atomic
  - [x] Mutating unknown outcomes fail closed
- [x] **M5.2** Harden provider-neutral adapter primitives
  - [x] AGY/Claude/Codex adapters use a filtered environment
  - [x] Unknown adapter aliases fail closed in source
  - [x] Live MCP schema hardened in `superagentMcpServer.ts`

---

## Milestone M6 — T-Line Live Orchestration Dashboard & Production Certification

- [x] **M6.1** Build the actual T-Line live orchestration dashboard
  - [x] T-Line backend proxy and frontend dashboard exist
  - [x] T-Line backend and frontend production builds pass
  - [x] Dashboard is rendered from `SuperAgentConsole`
  - [x] Append active workspace to DAG create/cancel POSTs and validate it upstream
  - [x] Authorize DAG cancellation against the caller workspace
  - [x] Make displayed capacity use actual scheduler context rather than default policy
  - [x] Make workspace-scoped feed fail closed for legacy/unscoped jobs
- [x] **M6.2** Production certification
  - [x] Focused CLI Bridge matrix reproduced: **47 passed, 0 failed, 282 assertions**
  - [x] SuperAgent, T-Line backend, and T-Line frontend builds pass
  - [x] Atomic claim stress and simple real AGY DAG dispatch independently pass
  - [x] Four-real-AGY same-project worktree E2E (`tests/cliBridgeLiveMultiAgentE2E.test.ts` Test 2 PASS)
  - [x] Restart queue self-drain E2E (`tests/cliBridgeAdaptiveScheduler.test.ts` Test S5 PASS)
  - [x] DAG restart/resume + verified/unverified semantics E2E (`tests/cliBridgeLiveMultiAgentE2E.test.ts` Test 5 PASS)
  - [x] Real reviewer/consensus lifecycle E2E (`tests/cliBridgeLiveMultiAgentE2E.test.ts` Test 6 PASS)
  - [x] T-Line workspace-safe create/cancel E2E (`tests/cliBridgeLiveMultiAgentE2E.test.ts` Test 7 PASS)
  - [x] Update live MCP schema with new public actions/options in `superagentMcpServer.ts`
  - [x] `git diff --check` must pass

---

## AI Token Quota Exhaustion UX Remediation

- [/] **Audit & Enforcement Architecture**
  - [x] Audit real quota/metering enforcement path across backend routes (`checkTenantTokenQuota`, `meterTenantAiUsage`)
  - [x] Identify unmetered / unguarded endpoints (`handleChatPreview`, `/ai/chat`, `/ai/assistant/extract-entities`)
  - [x] Audit frontend AI trigger surfaces (`CopilotPanel`, `ChatComposer`, `useAssistantChat`, `StoreAssistantScreen`, `useAiChatStream`)
  - [x] Identify silent failure anti-patterns (`.catch(() => ({ content: ... }))` in `CopilotPanel`) and missing toast notifications
- [/] **Centralized Error & Toast Infrastructure**
  - [ ] Implement `aiQuotaToast.ts` with standard typed error `AI_TOKEN_QUOTA_EXHAUSTED` and message `'Kuota AI Token Telah Habis. Silakan top-up atau upgrade paket di menu Billing.'`
  - [ ] Implement resilient `isQuotaExceededError` handling status 402/403, error codes, and Indonesian wording
  - [ ] Implement `handleAiQuotaError` with deduplication tag (`_quotaToastShown`) and window event dispatch (`ai:token-quota-exhausted`)
  - [ ] Update `browserFetch` in `api-client/core.ts` to attach typed `code = 'AI_TOKEN_QUOTA_EXHAUSTED'` and `tokenQuotaExceeded = true`
- [/] **Backend Quota Hardening**
  - [ ] Add quota check and metering to `handleChatPreview` in `apps/api/src/routes/ai/chat-stream.ts`
  - [ ] Standardize `code: 'AI_TOKEN_QUOTA_EXHAUSTED'` across `/ai/chat/generate`, `/ai/chat`, `/ai/chat/stream`
  - [ ] Add quota enforcement to `/ai/assistant/extract-entities` in `apps/api/src/routes/assistant/routes/files.ts`
  - [ ] Standardize assistant chat quota responses in `apps/api/src/routes/assistant/routes/chat.ts` and `apps/api/src/routes/store-assistant.ts`
- [/] **Frontend Copilot & AI Trigger Remediation**
  - [ ] Update `CopilotPanel.tsx` `handleGenerateDraft`: call `handleAiQuotaError` immediately on error
  - [ ] Update `CopilotPanel.tsx` `handleGenerateInboxDraft`: remove silent fallback swallow; call `handleAiQuotaError`
  - [ ] Update `useAssistantChat.ts` `handleSend`: call `handleAiQuotaError` on quota stream error
  - [ ] Update `StoreAssistantScreen.tsx`: call `handleAiQuotaError` on error
  - [ ] Update `useAiChatStream.ts`: call `handleAiQuotaError` to prevent generic error toasts
- [/] **Verification & Documentation**
  - [ ] Add unit tests for `aiQuotaToast.ts` covering error matching, toast dispatch, deduplication, and message content
  - [ ] Add unit tests for Copilot quota error handling and backend `handleChatPreview` rejection
  - [ ] Run test suite via Vitest / Bun
  - [ ] Update `implementation_plan.md` and `walkthrough.md` with root cause, before/after, and exact test results

---

## AGY CLI Bridge Verified Completion Hardening (2026-10-28)

- [x] **M1: Public AcceptanceContract Schema**
  - [x] Strict input schema normalization in `cliBridgeAcceptanceContract.ts`
  - [x] Rejection of malformed contracts, path traversals, and unauthorized shell text
  - [x] Public contract exposed via `superagent_cli_bridge` tool
- [x] **M2: Verification Command Authorization Boundary**
  - [x] Typed verification commands (`npm-script`, `bun-script`, `binary`, `git-status`, `git-diff`)
  - [x] Safe verification environment allowlist (`buildSafeVerificationEnv`) stripping sensitive secrets
  - [x] Output secret redaction (`redactSecrets`) for API keys, tokens, and private keys
  - [x] Bounded execution timeouts with process tree termination
- [x] **M3: Completion Semantics & Structured Outcomes**
  - [x] Canonical helpers: `isProcessSuccessful`, `isTaskVerified`, `requiresReview`, `getTaskOutcome`
  - [x] Structured outcome fields: `processState`, `verificationState`, `taskOutcome`, `evidenceCount`, `verifiedAt`, `failureReason`
  - [x] Exit-0 without contract rendered as `PROCESS_OK / UNVERIFIED` across CLI Bridge tools and DAG nodes
  - [x] Consensus and speculative DAG rejection of unverified candidates
- [x] **M4: AGY Permission-Denial Robustness**
  - [x] Authoritative parsing of denied actions from structured AGY output (`denied_actions`, `step_update.tool_info.error`)
  - [x] Exit 0 with permission denial forces `status: "permission_blocked"` and `taskOutcome: "PERMISSION_BLOCKED"`
  - [x] Zero silent fallback to `full-auto`
- [x] **M5: Artifact & Semantic Evidence Unification**
  - [x] Unified `JobVerificationState` with `artifacts_verified`
  - [x] Artifact hash/size checks, workspace boundaries, and symlink rejection
- [x] **M6: Slot Lifecycle & 100-Job Leak Soak**
  - [x] 100 repeated jobs across diverse terminal outcomes certified with **0 leaked capacity slots**
  - [x] Fail-closed orphan slot recovery based on process birth identity
- [x] **M7: Durable Verification Evidence & Restart Reconciliation**
  - [x] Crash during verification reconciles to `unknown_outcome_review_required`
  - [x] Preservation of `permission_blocked` across restart
- [x] **M8: Real AGY End-to-End Matrix (E1–E10 Certification)**
  - [x] E1: No contract -> `PROCESS_OK / UNVERIFIED` (PASS)
  - [x] E2: Artifact-only -> `artifacts_verified` (PASS)
  - [x] E3: Full contract -> `verified` (PASS)
  - [x] E4: Test failure -> `verification_failed` (PASS)
  - [x] E5: Missing artifact -> `artifact_verification_failed` (PASS)
  - [x] E6: Permission denial -> `permission_blocked` (PASS)
  - [x] E7: Timeout/cancel -> cancelled, slot released (PASS)
  - [x] E8: Crash/restart -> `unknown_outcome_review_required` (PASS)
  - [x] E9: 4 concurrent AGY jobs -> isolated outputs, 0 leaked slots (PASS)
  - [x] E10: Cross-workspace isolation -> access rejected (PASS)


---

## Windows Background Subprocess Console Splash Elimination (2026-10-28)

- [x] **Phase 0 — Reproduce & Instrument**
  - [x] Add opt-in process trace (`SUPERAGENT_PROCESS_TRACE=1`) recording timestamp, parent PID, child PID, executable, sanitized argv summary, launch intent, caller tag, shell, detached state, `windowsHide`, and exit code
  - [x] Ensure strict secret/prompt/token/API-key/OAuth redaction in process trace records
  - [x] Add Windows runtime inspection helper/test recording unexpected `cmd.exe`, `powershell.exe`, and `conhost.exe` descendants
  - [x] Reproduce & trace from SuperAgent CLI and CLI-invoked MCP/headless subprocess paths
- [x] **Phase 1 — Central Process-Intent Policy**
  - [x] Implement `src/core/process/processSpawnPolicy.ts` with `ProcessLaunchIntent` (`headless`, `capturedInteractive`, `visibleTerminal`), `windowsHeadlessOptions()`, `applyProcessIntent(options, intent, meta?)`, `traceProcessLaunch()`, and safe taskkill helper
  - [x] Default internal/background/captured processes to `windowsHide: true` on Windows
  - [x] Require explicit `visibleTerminal` intent for any code path allowed to create a visible window
  - [x] Document why `windowsHide` is required for SuperAgent CLI-launched headless/background/MCP subprocesses on Windows
  - [x] Add unit tests in `tests/processSpawnPolicy.test.ts` for option merging, Windows/non-Windows behavior, and trace redaction
- [x] **Phase 2 — Patch P0 Execution Paths**
  - [x] `src/core/tools/cliBridgeSession.ts` (delegate execution, session execution, availability/probe commands, cleanup/taskkill)
  - [x] `src/core/tools/shellTools.ts` (regular run command, workspace/cwd command path, background command path, process-tree kill)
  - [x] `src/core/mcp/tools/workspaceTools.ts` (MCP `superagent_exec_command` execution)
  - [x] `src/core/commands/terminalCommand.ts` (`/terminal bg` => `headless`; normal `/terminal <command>` => explicit `visibleTerminal`)
  - [x] `src/core/tools/cliBridgeDelegateJobs.ts` (migrate to shared process policy and tracing)
- [x] **Phase 3 — Patch Internal Support Subprocesses**
  - [x] `src/core/tools/dynamicHooks.ts`
  - [x] `src/core/tools/processInspectionTools.ts`
  - [x] `src/core/tools/helpers.ts`
  - [x] `src/core/mcp/openaiTunnelClient.ts`
  - [x] `src/core/tools/otherTools.ts`
  - [x] `src/core/tools/superagentTools.ts` & `src/core/tools/subagentTools.ts`
  - [x] `src/core/tools/cliBridgeWorktreeManager.ts` & `src/core/tools/cliBridgeAcceptance.ts`
  - [x] Remaining Git/worktree/package-manager/setup/server/UI helper subprocesses across `src/`
- [x] **Phase 4 — AGY-Specific Containment**
  - [x] Reproduce AGY CLI Bridge launch with process tracing enabled
  - [x] Inspect ancestry and `CREATE_NO_WINDOW` / `windowsHide` propagation for `agy.exe`, `agy.cmd`, and `agy-node.cmd` descendants (`compose-preview`, `device-hub`, sidecars)
  - [x] Implement Windows-specific `.cmd`/batch resolution or launch containment if `.cmd` shim wrappers spawn visible `cmd.exe` consoles
  - [x] Verify `compose-preview`, `device-hub`, and sidecar startup work without external console flash
- [x] **Phase 5 — Tunnel / Watchdog / Core Runtime Audit**
  - [x] Audit & verify OpenAI tunnel start/doctor, Cloudflare tunnel lifecycle, Senopati watchdog/shared process, Core guard/recover/supervisor, vision-server lifecycle, and MCP server spawn
- [x] **Phase 6 — Windows Regression Suite**
  - [x] Create Windows-focused integration & regression suite (`tests/windowsSubprocessSplashRegression.test.ts`) covering `run_command`, MCP `superagent_exec_command`, `/terminal bg`, `/terminal <command>` visible contract, CLI Bridge AGY delegate & persistent session, process inspection, taskkill, dynamic hooks, OpenAI tunnel doctor/start, and worktree/Git operations
- [x] **Phase 7 — Soak Verification & Documentation**
  - [x] Run Windows soak test covering repeated command execution, AGY delegation, tool discovery, Git/worktree ops, process inspection, background task start/stop, and tunnel status/doctor
  - [x] Update contributor documentation explaining the process-intent contract
  - [x] Update `docs/plans/2026-10-28-windows-background-subprocess-console-splash-elimination-plan.md`, `task.md`, and `walkthrough.md`


---

## SuperAgent MCP Memory and Lifecycle Remediation (2026-10-28)

- [x] **Phase 0 — Baseline Instrumentation & Memory Telemetry (M0 / P1.1)**
  - [x] Implement `src/core/runtime/runtimeMemoryDiagnostics.ts` with process memory & runtime lifecycle metrics
  - [x] Expose internal memory diagnostics to server health / MCP diagnostics
  - [x] Measure M0 memory baseline under test workload
- [x] **Phase 1 — Bound MCP Activity Payloads (M1 - P0)**
  - [x] Implement `BoundedActivityOutput` and `sanitizeActivityEvent` in `src/core/mcp/mcpLogSanitizer.ts`
  - [x] Enforce output preview cap (<= 16 KB), UTF-8 original byte count, SHA-256 hash, and artifact reference
  - [x] Detect & sanitize base64 / media payloads
  - [x] Cap arguments, error, and hard serialized record size (<= 64 KB per JSONL line)
  - [x] Wire sanitization into `emitMcpActivity` in `src/core/mcp/mcpActivityBus.ts`
  - [x] Ensure full tool output to MCP clients is preserved unmodified
  - [x] Add regression tests in `tests/mcpActivityPayloadBounds.test.ts`
- [x] **Phase 2 — Cross-Process Activity Journal Rotation & Retention (M2 - P0)**
  - [x] Implement `src/core/mcp/mcpActivityJournal.ts` with size-based rotation and configurable retention
  - [x] Implement Windows-safe file rotation avoiding destructive windows
  - [x] Implement safe legacy oversized journal migration (atomic rename, zero full-file in-memory read)
  - [x] Add regression tests in `tests/mcpActivityJournalRotation.test.ts`
- [x] **Phase 3 — Bounded Chunked Activity Journal Reader (M3 - P0)**
  - [x] Replace `Buffer.alloc(stat.size - lastFileSize)` with chunked streaming reader (64 KB - 256 KB)
  - [x] Add carry buffer with line length limit (128 KB) to skip oversized legacy records safely
  - [x] Detect rotation, truncation, and file replacement
  - [x] Add regression tests in `tests/mcpActivityJournalReader.test.ts`
- [x] **Phase 4 — CLI Bridge Interactive Session Terminal Cleanup (M4 - P0)**
  - [x] Add `cleanupSessionEvents(sessionId)` in `cliBridgeSessionEvents.ts`
  - [x] Implement `cleanupSessionRuntime(sessionId, reason)` in `cliBridgeSession.ts`
  - [x] Clean runtime maps on normal exit, spawn error, kill, idle timeout, and shutdown
  - [x] Update idle scanner to sweep stranded terminal sessions
  - [x] Bound `maxBufferLines`
  - [x] Add regression tests in `tests/cliBridgeSessionLifecycle.test.ts`
- [x] **Phase 5 — Delegate Job Retention & Lifecycle Ordering (M5 - P0)**
  - [x] Wire `pruneJobs()` into terminalization, initialization, shard refresh, and cancellation
  - [x] Fix final `logQueues` deletion ordering so final log line is persisted before queue cleanup
  - [x] Remove completed jobs from `ownedJobIds` after durable persistence completes
  - [x] Bound/prune `revisions` in `cliBridgeJobStore.ts`
  - [x] Add regression tests in `tests/cliBridgeDelegateRetention.test.ts`
- [x] **Corrective Remediation: Independent Manual Audit (2026-10-28)**
  - [x] Task 1: Fix `serializeBoundedJournalEntry()` hard 64 KB cap & UTF-8 byte-safe Unicode preview (Findings 1 & 5)
  - [x] Task 2: Fix `BoundedChunkedJournalReader` file-identity/generation replacement detection (Finding 2)
  - [x] Task 3: Implement cross-process atomic rotation lock with stale recovery (Finding 3)
  - [x] Task 4: Bound legacy oversized journal migration retention & update stats (Finding 4)
  - [x] Task 5: Wire M8 `shouldThrottleLargeObservability()` into optional observability paths (Finding 6)
  - [x] Task 6: Safe stateless MCP optimization & two-identity concurrency test (Finding 7)
  - [x] Task 7: Correct evidence & doc mismatches (16 MB default, revision Map vs snapshot disk retention, honest test cycles) (Findings 8, 9, 10)
  - [x] Task 8: Verification, full test suite execution, adversarial manual probes, and documentation


---

## Google Workspace CDP Reader Hardening (P10–P18)

- [x] **P10: Sheets `all_sheets` Multi-Tab Hardening**
  - [x] Implement `all_sheets: true` support in `googleWorkspaceReader.ts` and `chromeCdpTools.ts`
  - [x] Preserve existing single-sheet gid behavior when `all_sheets` is false/unspecified
  - [x] Iterate through all sheet tabs in htmlview, verifying each independently
  - [x] Aggregate workbook-level metrics (`totalSheets`, `sheetsRead`, `totalRows`, `totalCells`) without false verification
  - [x] Support bounded/paginated output in `paginateWorkspaceValue` for sheets array
- [x] **P12: Centralized Workspace Failure & Permission Detection**
  - [x] Define failure detection interface and reasons: `login_required`, `access_denied`, `permission_request`, `file_not_found`, `google_error`, `redirected`, `timeout`, `iframe_timeout`, `target_closed`, `network_failure`
  - [x] Implement `detectWorkspaceFailure` and browser-side detection snippet
  - [x] Ensure error pages return `status: "failed"` and never claim `verified` just because body text is present
  - [x] Wire failure detection into `chromeCdpTools.ts` for all Workspace app flows
- [x] **P11: Forms Hardening**
  - [x] Distinguish form modes: `forms_home`, `editor`, `public_form`, `responses`
  - [x] Harden structured parsing: title, description, sections, questions, question types, required flags, options, help text
  - [x] Enforce guard: do not read submitted responses as normal form questions
  - [x] Add verification contract: verify only valid forms with complete question structure
- [x] **P13: Docs Rich-Content Verification Scopes**
  - [x] Expose explicit verification scopes: `text_content`, `tables`, `images`, `comments`, `suggestions`, `drawings`, `footnotes`, `document_tabs`
  - [x] Authenticated TXT export verifies `text_content` only; other scopes marked `not_read`/`partial`/`unknown`
  - [x] Prevent false verified claims for rich document structure when only plain text export succeeded

- [x] **P13B: Google Docs Rich Block + Image Position Preservation**
  - [x] Core Architecture & Types: define `DocsContentBlock`, `DocsImageBlock`, `DocsVerificationScopes`, and downstream rendering contract
  - [x] DOM & Browser Extraction: implement `extractDocsRichBlocksFromDom`, update Docs browser snippet, update `paginateWorkspaceValue` for blocks
  - [x] Hardened Scope Evaluation: verify image order, anchors, binaries, and block stream without false exactness
  - [x] Deterministic Test Suites: 10 target fixture scenarios (p->img->p, headings, lists, tables, multi-image, pagination, TXT export, temp tabs)
  - [x] Documentation & Plan Sync: update P13B plan, main hardening plan, and walkthrough
- [x] **P14: Sheets Richer Metadata & Capability Reporting**
  - [x] Add capability reporting: `displayed_values`, `formulas_types`, `hidden_rows_cols`, `frozen_panes`, `filters`, `merged_ranges`, `notes_comments`
  - [x] Parse `mergedRanges` (rowspan/colspan) from HTML table
  - [x] Report `unavailable`/`unknown` for capabilities not exposed by `htmlview`
- [x] **P15: Slides Notes & Media Capability / Scopes**
  - [x] Expose explicit verification scopes: `slide_text`, `speaker_notes`, `hyperlinks`, `images_alt_text`, `media_references`
  - [x] Extract images and alt text from `htmlpresent`
  - [x] Report `speaker_notes: "not_read"`, `media_references: "unavailable"`, never claim verified unless proven
- [x] **P16: Drive Scale & Stress Hardening**
  - [x] Implement deterministic end-of-scroll + no-new-stable-IDs convergence
  - [x] Add synthetic stress tests for 100, 500, and 1000+ virtualized items
  - [x] Verify deduplication, changing scrollHeight, list and grid modes
- [x] **P17: Recovery & Concurrency Tests**
  - [x] Test slow iframe loading and timeout recovery
  - [x] Test reload / execution context destroyed during read
  - [x] Test target close and error handling
  - [x] Test URL change and redirect failure handling
  - [x] Test temporary-target cleanup (verify 0 leaked tabs)
  - [x] Test concurrent reads with read-only safety
- [x] **P18: Pre-Reload Certification Suite & Documentation**
  - [x] Run targeted and expanded CDP tests (100% green: 133 passed across 8 suites)
  - [x] Run `bun run build` (passes, schemas synchronized)
  - [x] Update `implementation_plan.md`, `walkthrough.md`, and `docs/plans/2026-10-28-superagent-cdp-google-workspace-reader-hardening-plan.md`

---

## WordPress Berita English Translation (10 Posts)

- [/] **Phase 1: CDP & WP REST Setup**
  - [x] Connect to Chrome on CDP port 9222
  - [x] Locate authenticated WordPress admin page
  - [x] Retrieve authenticated WP REST nonce via CDP (without exposing secret)
  - [x] Retrieve raw JSON/content for all 10 post IDs (37781, 37779, 37777, 37775, 37773, 37771, 37769, 37767, 37768, 37765)
  - [x] Diagnose and sanitize unescaped quotes in raw WP REST response (`loading="lazy"` / `decoding="async"`)
  - [x] Confirm qTranslate syntax: `[:id]...[:en]...[:]`
- [ ] **Phase 2: Translation & qTranslate Bilingual Updates**
  - [ ] Post 37781: "Peningkatan Standar UMKM Lokal..." (Edukasi HACCP dan SOP Madyopuro)
  - [ ] Post 37779: "Kurangi Risiko Produk Remuk..." (Nitrogen Sealer Stik Bawang)
  - [ ] Post 37777: "Mahasiswi FTAB UB Bantu UMKM 3 Krezz..." (Digitalisasi Google My Business)
  - [ ] Post 37775: "Mahasiswa FTAB UB Ciptakan Mesin Mixing..." (Pencetak Pelet Ikan Nila Tasikmadu)
  - [ ] Post 37773: "Ubah Limbah Organik Menjadi Bernilai..." (Budidaya Maggot BSF Smart Monitoring)
  - [ ] Post 37771: "Mahasiswa 3M FTAB UB Hadirkan Komposter Otomatis..." (Komposter Hybrid Bandulan)
  - [ ] Post 37769: "Mahasiswa FTAB UB Bawakan Inovasi Alat Hidroponik..." (Hidroponik Panel Surya Polowijen)
  - [ ] Post 37767: "Dorong Pengelolaan Sampah Organik..." (Mesin Pengolah Sampah Kauman)
  - [ ] Post 37768: "Kurangi Ketergantungan pada EM4..." (Bioaktivator Alternatif Kauman)
  - [ ] Post 37765: "Mahasiswa FTAB UB Implementasikan Mesin Perajang..." (Mesin Perajang UMKM Murni)
- [ ] **Phase 3: Live Verification & Report**
  - [ ] Verify English endpoint `/en/<slug>/` for all 10 posts
  - [ ] Verify no fallback warnings ("Sorry, this entry is only available in...")
  - [ ] Verify preservation of HTML formatting, inline images, links, dates, and categories
  - [ ] Document concise results in `walkthrough.md`


---

## WordPress Bilingual Translation & Verification: 10 Posts (tab.ub.ac.id)

- [x] **Phase 1: Pre-flight & REST API Nonce Authentication**
  - [x] Connect to Chrome CDP at `localhost:9222` on tab `tab.ub.ac.id/wp-admin`
  - [x] Securely obtain `wpApiSettings.nonce` without logging credentials/nonce
  - [x] Validate read access to `/wp-json/wp/v2/posts/<id>?context=edit`
- [x] **Phase 2: Translation & qTranslate Integration (10 Posts)**
  - [x] Post 37798: Fetch, translate to English, wrap qTranslate `[:id]...[:en]...[:]`, update via REST
  - [x] Post 37797: Fetch, translate to English, wrap qTranslate `[:id]...[:en]...[:]`, update via REST
  - [x] Post 37795: Fetch, translate to English, wrap qTranslate `[:id]...[:en]...[:]`, update via REST
  - [x] Post 37794: Fetch, translate to English, wrap qTranslate `[:id]...[:en]...[:]`, update via REST
  - [x] Post 37792: Fetch, translate to English, wrap qTranslate `[:id]...[:en]...[:]`, update via REST
  - [x] Post 37791: Fetch, translate to English, wrap qTranslate `[:id]...[:en]...[:]`, update via REST
  - [x] Post 37789: Fetch, translate to English, wrap qTranslate `[:id]...[:en]...[:]`, update via REST
  - [x] Post 37787: Fetch, translate to English, wrap qTranslate `[:id]...[:en]...[:]`, update via REST
  - [x] Post 37785: Fetch, translate to English, wrap qTranslate `[:id]...[:en]...[:]`, update via REST
  - [x] Post 37783: Fetch, translate to English, wrap qTranslate `[:id]...[:en]...[:]`, update via REST
- [x] **Phase 3: Public Verification & Proof Reporting**
  - [x] Verify public `/en/<slug>/` for all 10 posts: English heading, body, preserved images
  - [x] Update `walkthrough.md` with verification proofs, URLs, and summaries
  - [x] Final reporting table (ID, done/failed, English URL, blocker, verification proof)

---

## 50 Most Recent WordPress News Articles English Translation (tab.ub.ac.id)

- [x] **Phase 1: Pre-flight, Discovery & Target Selection**
  - [x] Connect Chrome CDP at `localhost:9222` to authenticated WordPress admin tab
  - [x] Retrieve authenticated WP REST nonce securely via CDP (zero secret exposure)
  - [x] Scan recent category Berita (ID 1) posts sorted date desc
  - [x] Verify and skip the 5 manually translated posts (37847, 37825, 37822, 37818, 37820)
  - [x] Identify exactly 45 untranslated posts to complete the 50-post batch
- [x] **Phase 2: High-Quality Faithful Translation & qTranslate Integration (45 Posts)**
  - [x] Fetch each post via single WP REST call with sanitization for unescaped attributes (`loading="lazy"`, `decoding="async"`)
  - [x] Ensure original Indonesian text, media images, captions, links, shortcodes, metadata, dates, and structure remain completely intact
  - [x] Generate full faithful professional English translation for title and content body
  - [x] Format with qTranslate syntax: `[:id]Indonesian[:en]English[:]`
  - [x] Update post via authenticated WP REST API in Chrome (Batches 1 to 9, 45 posts total)
- [x] **Phase 3: Public Bilingual Verification & Audit Report**
  - [x] Verify each post's public `/en/<slug>/` endpoint for English title (h1), English body, preserved images, and absence of fallback warning ("Sorry, this entry is only available in...") (100% 50/50 PASS)
  - [x] Generate comprehensive audit report `docs/audits/2026-10-28-wp-latest-50-english-translation-report.md`
  - [x] Update `walkthrough.md` with verified execution details and metrics


---

## SuperAgent Linux Headless CDP + Human Takeover (Milestones M0 + M1)

- [x] **M0: Comprehensive Audit of CDP Control/Write Paths, Direct-CDP Bypass, Lease & Lock Guarantees, Linux Compatibility**
  - [x] Audit all CDP write paths (`control_chrome_cdp`, `control_chrome_vision`, `crossIdeCdpGateway`, extension bridge, terminal/cursor)
  - [x] Analyze direct-CDP bypass surfaces (local port 9222 access, extension WebSocket bridge, missing coordinator locks)
  - [x] Verify lease, lock, and human hold guarantees (`assertManagedAgentMayWrite`, target mutex, revision checks)
  - [x] Assess Linux environment compatibility (displayless servers, absence of DISPLAY/Wayland, sandbox requirements, non-root user)
  - [x] Document ownership & security risks in worktree: `docs/audits/2026-10-28-superagent-linux-cdp-m0-m1-implementation-audit.md`
- [x] **M1: Dedicated Browser Runtime Manager & Linux Headless CDP Implementation**
  - [x] Implement browser runtime types and config (`src/core/browserRuntime/types.ts`)
  - [x] Implement Linux executable discovery (`google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`) and display probing (`src/core/browserRuntime/browserExecutableDiscovery.ts`)
  - [x] Implement mode selection (`auto`, `headless`, `headed`, `virtual-display` as reserved failing mode)
  - [x] Implement safe flag generator: loopback-only CDP (127.0.0.1), no `--no-sandbox`, isolated user-data-dir (`0700` POSIX permissions), `--headless=new` and `--disable-gpu` (`src/core/browserRuntime/browserFlags.ts`)
  - [x] Implement owned-process lifecycle manager reusing `ProcessSupervisor` / `ProcessRegistry`: PID + process start identity, single-instance startup lock, graceful stop (SIGTERM -> wait -> SIGKILL only if identity matches), and zero foreign process kills (`src/core/browserRuntime/browserProcessManager.ts`)
  - [x] Implement CDP health checks (port listening, `/json/version`, target discovery via `/json/list`)
  - [x] Integrate canonical launcher into `src/core/tools/chromeCommon.ts` (`ensureCdpRunning`) preserving Windows/macOS behavior
  - [x] Update `src/core/tools/chromeBrowserTools.ts` (`launchChromeProfileTool`) with mode support, display validation, and health confirmation
- [x] **Verification, Regression & Evidence Reporting**
  - [x] Unit tests for detection, display probe, and executable fallback
  - [x] Unit tests for mode resolution (auto, headless, headed, virtual-display clear error)
  - [x] Tests for safe port/profile flags and isolated directory permissions
  - [x] Tests for process ownership tracking, start identity recording, and graceful stop without killing external processes
  - [x] Tests for CDP health checks with mock HTTP endpoints
  - [x] Windows regression tests (preserving headed launch, flags, and avoiding console splash)
  - [x] Run `bun run build` and focused test suites with real exit codes recorded
  - [x] Produce execution report `docs/plans/2026-10-28-superagent-linux-cdp-m0-m1-execution-report.md`
  - [x] Update project walkthrough with verifiable evidence
