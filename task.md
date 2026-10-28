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
