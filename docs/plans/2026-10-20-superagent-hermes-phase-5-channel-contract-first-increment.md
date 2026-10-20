# Hermes Phase 5 — Shared Channel Contract and Notification Reliability

Date: 2026-10-20
Scope: First bounded increment of Phase 5; NOT the full Phase 5 production exit gate.
Master: docs/plans/2026-10-18-superagent-hermes-like-implementation-master-reference.md

## Implemented

- src/core/channels/unifiedChannelTask.ts introduces read-only execution envelopes for existing CLI Bridge and daemon records. Each envelope exposes channel, task identity, project/workspace, normalized status, conservative artifact evidence, delivery status, and bounded redacted summary. It never embeds conversation history and does not replace source ledgers.
- CLI Bridge delegate.get displays normalized status; daemon CLI history and inspect-run add normalized status/evidence. Daemon GET /api/daemon/runs and GET /api/daemon/runs/:runId expose optional normalized=1 channel task projections, leaving existing API output unchanged when unspecified.
- authorizeChannelOperation models minimum trusted identity, workspace, write/privileged capabilities and independent out-of-band owner approval; it is a reusable contract, NOT wired to all existing entry points and must never be used to infer that inbound messages authorize mutation.
- Daemon notification delivery retries an explicit negative adapter response once. It does not retry ambiguous timeouts (remote provider may already have accepted delivery); task success remains independent from notification failures. Delivery error messages remain redacted and bounded.
- Regression tests verify status/evidence distinction, negative channel authorization, opt-in API compatibility and bounded notification retry without rerunning the task.

## Explicit limitations

- This is the first phase-5 increment, not complete channel-policy enforcement. T-Line, tunnel, gateway and MCP still require entry-point-by-entry-point adapters/authorization gate verification.
- No automatic replay of uncertain message delivery. This avoids duplicate external messages but delivery outcome can remain failed/unknown.
- Memory bootstrap and task-store convergence, session identity normalization, delivery correlation/idempotency, cross-channel permission checks, live provider acceptance and staging are NOT complete.
- Concurrent Motion Studio source changes may temporarily make full TypeScript build fail independently of this increment. Never amend unrelated code for a Phase 5 commit.

## Local acceptance

- Targeted CLI Bridge, daemon scheduler, daemon routes and shared contract Vitest tests pass.
- Follow-up required: full build and regression against a stable, nonconcurrent source snapshot; then complete remaining Phase 5 exit gates.
