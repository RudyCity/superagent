# Implementation Plan: 2026-10-28 Algorithm Remediation

## Goal
Implement deep algorithmic remediations across the 7 critical priority areas identified in the 2026-10-28 re-audit:
1. **P0 DEEP-01**: FastPath false-success elimination & fail-closed chatRuntimeProcessor.
2. **P0 DEEP-02**: Delegated `fileScope` hard code enforcement (immutable per-subagent boundary).
3. **P1 DEEP-03**: Subagent permission overhaul (parent/scoped approval inheritance, eliminating blind auto-approve).
4. **P1 DEEP-04**: Execution-scoped classifier progress callback routing (eliminate shared mutable singleton).
5. **P1 DEEP-05**: Concurrency limiter 0..N support and owned lease/heartbeat lock management.
6. **P1 DEEP-07**: Text-only checklist nudge loop prevention and no-progress termination.
7. **P2 DEEP-11**: Subagent question handling: remove silent `options[0]` fallback; explicit needs-input state.

## Scope & Target Areas

### Cluster 1: DEEP-01 FastPath & Chat Runtime Processor
- `src/core/agent/FastPath.ts`:
  - Set explicit terminal outcome on success (`completed`), abort (`aborted`), and error (`failed`).
  - Ensure durable terminal state is recorded/emitted exactly once.
- `src/core/utils/chatRuntimeProcessor.ts`:
  - Fail closed: null/unknown outcome must not become `completed` (mark as `failed`).
  - Unit/regression tests covering success, network/throw failure, abort, null/unknown outcomes.

### Cluster 2: DEEP-02 Delegated fileScope Hard Enforcement
- `src/core/tools/subagentTools.ts` / `src/core/tools/state.ts` / tool execution interceptor:
  - Attach immutable `fileScope` to subagent runtime state.
  - Enforce check on all file access tools (read, write, edit, patch, dir, etc.) and shell execution targeting or touching paths.
  - Canonicalize Windows paths (`path.resolve`, case-insensitivity on Windows, normalization, symlink resolution).
  - Child cannot escape `fileScope` even in YOLO mode (fileScope is explicit boundary assigned by parent).
  - Regression tests for allowed paths, sibling/outside paths, traversal (`../`), symlink/reparse attacks, and shell chdir/exec paths.

### Cluster 3: DEEP-03 Subagent Permissions & Approval Inheritance
- `src/core/tools/subagentTools.ts` & `src/core/tools/superagentTools.ts`:
  - Eliminate broad auto-approve (`auto-approve everything else`).
  - Delegate/inherit parent permission handler or enforce fail-closed scoped approval.
  - Maintain audit provenance of requesting subagent session and parent session.
  - Tests covering non-destructive unapproved actions failing or delegating to parent handler.

### Cluster 4: DEEP-04 Classifier Progress Callback Routing
- `src/core/tools/state.ts` / `src/core/requestClassifier.ts`:
  - Replace mutable singleton `globalProgressCallback` with execution context or agent-scoped callback passing.
  - Verify concurrent calls across agents/sessions cannot cross-contaminate progress events.
  - Tests proving isolation under concurrency.

### Cluster 5: DEEP-05 Concurrency Limiter (0..N) & Lease-based Lock Ownership
- `src/core/rateLimiter.ts`:
  - Update `SharedConcurrencyLimiter` to support `concurrencyLimit = 0` (unlimited), `1`, `2`, `N`.
  - Replace >60s timestamp-based lock theft with owner token/lease or heartbeat verification.
  - Callers only release locks/slots they own.
  - Unit tests for limits 0, 1, 2, 3 and long-running holders (>60s) retaining lock ownership.

### Cluster 6: DEEP-07 Text-Only Checklist Nudge & Loop Prevention
- `src/core/agent/LoopIterationProcessor.ts` & `ChecklistContinuationGuard.ts`:
  - Distinguish genuine progress/action narration vs repetition loops vs user-facing questions or needs-input.
  - Implement hard loop prevention / no-progress cap on repetitive text narration.
  - Tests for conversational/question skipping, complex task narration, needs-input waiting, no-progress cap.

### Cluster 7: DEEP-11 Subagent Question Fallback Remediation
- `src/core/tools/subagentTools.ts` & `src/core/tools/superagentTools.ts`:
  - Remove silent `return options[0]` when no handler is provided.
  - Return explicit `needs-input` status or throw informative error requiring parent/user resolution.
  - Tests covering question handling without UI handler.

## Verification
- Run tests via `bun test` for each cluster.
- Run full regression suites.
- Check git diff to ensure zero unintended changes or untracked file pollution.
