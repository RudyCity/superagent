# Hermes Phase 4 — Delegation Outcome and Memory Adapter Reliability

**Date:** 2026-10-20
**Status:** Local bounded increment implemented; Phase 4 broader acceptance still open
**Master plan:** `docs/plans/2026-10-18-superagent-hermes-like-implementation-master-reference.md`

## Motivation and scope

A delegated agent's `sendMessage` resolution only confirms that its execution loop returned; it does not necessarily prove the requested work was completed. The previous subagent/superagent paths could label a child `completed` even when its report said `Blocked`, `Partial`, or verification failed. Background parent notifications could then claim the task succeeded. Parent background messages now use distinct SUBAGENT_COMPLETED / SUBAGENT_BLOCKED / SUBAGENT_UNVERIFIED markers, including follow-up notification equivalents.

This slice introduces a shared explicit outcome classifier for existing Markdown and JSON-to-Markdown report contracts, without requiring a new provider API or changing existing worktree orchestration.

## Implemented

- `src/core/tools/delegationOutcome.ts`: Extracts explicit `Status`, `Verification`, and `Tests` declarations from reports. Classifies `completed`, `blocked`, `partial`, `failed`, `cancelled`, and `unverified`. A failed test/verification overrides a claim of completion.
- `src/core/tools/subagentTools.ts`: Initial and follow-up executions now retain `reportOutcome`; explicit blocked/partial/failure/cancellation maps to non-success state, with truthful inline reports and background parent notifications. JSON reports must match the requested subagent ID, not merely have a syntactically valid ID.
- `src/core/tools/superagentTools.ts`: Before recording success, refuses explicitly incomplete reports even after build/test verification. The rejection preserves the original report and declared outcome for parent inspection. Redundant-agent termination and quorum require both `Completed` and passing tests; unverified completed processes show warnings, not success marks. Cancellations and explicit failures retain original report provenance when the parent transitions to non-success.
- `src/core/tools/types.ts`: Preserves original state-machine statuses while adding optional, separately inspectable `reportOutcome`.

## Additional Phase 3 → 4 evidence

- `tests/skillLearningMemoryAdapter.test.ts`: Runs the production `MemoryClient` adapter and learning bridge with a synthetic gateway key and an isolated in-memory storage implementation, verifying stored candidate metadata, exact run/feedback evidence, quarantine before recall, project scoping and cross-project denial, preservation of owner review, idempotent duplicate requests, and missing-key failure without writes. **No real gateway or provider is contacted.**
- `tests/delegationOutcome.test.ts`: Deterministic status/verification parser coverage.
- `tests/subagentDelegationOutcome.test.ts`: Inline/background blocked and partial reports never become verified successes; an unverified result remains distinguishable.
- `tests/awaitDelegationOutcome.test.ts`: Blocked/partial/failed/unverified peers do not terminate a working sibling; unverified completed reports are labeled with a warning.
- `tests/subagentDelegationOutcome.test.ts` also verifies actual AsyncLocalStorage parent notifications for blocked and unverified background results.
- Existing subagent failure, multi-mode, and skill learning regressions stay in the focused test batch.

## Compatibility and release blockers

**Bounded implementation, not complete Phase 4.** Earlier clients still receive the legacy `completed` instance status for a subprocess that returns without a structured terminal report, but they also receive `reportOutcome: unverified`; summaries must not treat this as a verified task. This compatibility choice is a follow-up hardening consideration.

Remaining Phase 4 work: explicit immutable project/worktree/task contract for all delegation providers (including SSH), structured completion and artifact verification for CLI bridge and multi-process jobs, concurrency and lock tests across independent local/remote projects, resource ceilings, provider outage and cancellation end-to-end, and verification of parent reports on real LLM providers.

External Phase 3 release gates remain: configured production RMemory gateway, live-model evaluation/replay/approval, actual authenticated MCP OAuth project grants, and staging smoke checks.

## Verification commands

```bash
bun run build
bunx vitest run tests/skillLearningMemoryAdapter.test.ts tests/skillLearningBridge.test.ts tests/delegationOutcome.test.ts tests/subagentDelegationOutcome.test.ts tests/awaitDelegationOutcome.test.ts tests/subagentFailureReport.test.ts tests/multiModeAudit.test.ts
git diff --check
```

A broader full suite should be run and the exact counts recorded separately before release. Do not combine overlapping focused and full-suite test totals.


## Verified local acceptance (2026-10-20)

- `bun run build` — passed.
- `bun run verify:extension-js` — passed (8 extension JavaScript files).
- `bun run wiki:validate` — passed (9 wiki files, 24 internal links).
- Final full Vitest `bunx vitest run --reporter=default --maxWorkers=3` — **exit code 0**, **369 suites passed**, **1 skipped**, **3,535 tests passed**, **5 skipped**, **0 failed**. Final test source includes the parent background notification and paused-resume compatibility regressions.
- Focused verification after the final compatibility patches — **58/58 passed in 9 suites**, covering the RMemory adapter, delegation classification, blocked/unverified notifications, parent quorum, paused resume, local project provider, and earlier regression cases.
- `git diff --check` — passed after source edits.

The full and focused totals overlap. Live-provider/MCP OAuth/SSH and staging requirements listed above remain release blockers, not passed gates.
