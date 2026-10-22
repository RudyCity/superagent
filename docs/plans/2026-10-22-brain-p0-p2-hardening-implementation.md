# Brain P0–P2 Hardening — Implementation and Acceptance
Date: 2026-10-22

## P0 repaired
1. **Nested scratch protection:** `hasActiveBrainDelegation` now recognizes exact scratch and descendants `scratch/agents/<agent>/<task>/`, without accepting a sibling whose path merely shares the string prefix. Both prepare and confirm cleanup fail closed for active jobs.
2. **T-Line job listing:** `/sessions/:id/jobs` accepts only canonical descendants of the owner's scratch and does not expose prompt or output. Nested delegated jobs appear in the UI.
3. **Artifact promotion:** verified CLI Bridge outputs can be promoted from exact or nested task scratch. Owner namespace, canonical working directory, regular-file checks, immutable SHA-256, reserved storage quota, create-only destination, and session-wide mutation lock apply.
4. **MCP agent capabilities:** `task.create` returns one-time `credentials` keyed by logical agent; only SHA-256 hashes are persisted in `.tasks/<taskId>.capabilities.json`. Every remote task mutation requires `agentCredential` for the matching `agentId`. `task.autostart` issues a single returned `agentCredential` for the delegated agent. Credentials are not returned by task list/get/resume. T-Line and local CLI retain separately authenticated trusted-operator authority. This is **task-level authorization**, not process sandboxing.

## P1 repaired
- `task.reconcile` and `task.resume` consult current persisted CLI Bridge job state on demand, never trusting the old Brain task status alone.
- Succeeded jobs with verified artifacts are promoted (up to 10 artifacts), checkpointed, and completed. Failed/interrupted jobs become `blocked`; cancellations become `cancelled`. A missing job or changed task owner results in review-required status instead of false success.
- Explicit `task.cancel.request` checks agent credentials, claimed task ownership, active persisted job status and exact nested cwd before asking CLI Bridge to cancel.
- Explicit `task.retry` accepts a new prompt only for an authorized blocked task with a **verified terminal previous job**. New job IDs are persisted on acceptance. No silent retries or background retry loops.
- MCP rejects manual terminal task updates while a delegate is still running or its state cannot be verified.
- Handoffs use separate actor scratch directories; only the assigned task actor can request them. Artifact promotion and storage are quota-checked. Multi-artifact promotion is bounded and create-only; if a multi-file promotion partially fails, the task is blocked for operator review, not falsely completed.

## P2 completed
- `brainTaskContinuity` reads a bounded number of last checkpoints from the SAME registered canonical project/RMemory provenance across sessions. Detached or foreign-project sessions are excluded.
- ContextBuilder includes at most four small, explicitly untrusted checkpoint references outside casual conversation. This is not an instruction layer and does not automatically save memories.
- The T-Line task panel polls persisted CLI job status while running; only sanitized job IDs/status/completion state appear, with explicit unavailable/refresh states. It has no capability to impersonate an MCP OAuth tenant.
- Automatic artifact discovery checks verified Bridge evidence instead of walking arbitrary project directories.

## MCP examples
```json
{"action":"task.create","sessionId":"sess","title":"Audit docs","agentIds":["agy","claude"]}
{"action":"task.claim","sessionId":"sess","taskId":"task_...","agentId":"agy","agentCredential":"bag_..."}
{"action":"task.cancel.request","sessionId":"sess","taskId":"task_...","agentId":"agy","agentCredential":"bag_..."}
{"action":"task.reconcile","sessionId":"sess","taskId":"task_..."}
{"action":"task.retry","sessionId":"sess","taskId":"task_...","agentId":"agy","agentCredential":"bag_...","cli":"agy","prompt":"Retry with corrected input"}
{"action":"task.resume","sessionId":"sess","taskId":"task_..."}
```
Treat `agentCredential` as a secret. Do not store it in prompts, telemetry, checkpoints or shared artifacts.

## Verification
```sh
bun scripts/sync-brain-runtime.ts --check
bun scripts/verify-brain-release.ts --with-tline
```
The tested coverage includes OAuth owner isolation, credential mismatch/missing agent credential, nested cwd cleanup protection, nested T-Line job listings, persisted task state reconciliation, bounded multiple verified outputs, RMemory project provenance, frontend Brain dashboard, Bun backend/frontend production build.

## Boundaries and outstanding operational checks
- OAuth through an already-deployed public tunnel, packaged T-Line GUI and real Claude CLI credentials require operator-authorized live verification; no unrelated active tunnel was restarted.
- T-Line local operator is privileged within `local-cli` namespace and is not an independently authenticated subagent. MCP remote agents have separate task-scoped credentials within the same authenticated owner.
- CLI jobs run with the host OS user's permissions; a nested scratch folder is not an OS sandbox.
- No automatic, irreversible scratch deletion or automatic RMemory write was introduced.
- Retry/cancel requests do not guarantee child termination until the Bridge reports a terminal persisted status.
- Multi-artifact promotion is not a single atomic multi-file transaction. On partial failure it stops and requires review.
- CI workflow source is present; actual remote CI execution and pushes are separate operational steps.
