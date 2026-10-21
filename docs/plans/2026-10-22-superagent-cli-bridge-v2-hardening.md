# SuperAgent CLI Bridge 2.0 — Hardening, Observability and Delegation

Date: 2026-10-22
Project: superagent | Existing MCP tool: `superagent_cli_bridge`

## Implemented

### Complete MCP contract
The exposed MCP input schema now includes the existing internal background/session operations and their real input fields: `jobId`, `sessionId`, `args`, `expectedArtifacts`, `timeoutMs`, `permissionMode`, `idempotencyKey`, `tailLimit`, session fields and more. The descriptions distinguish short synchronous delegation, background work and interactive sessions.

### Safe AGY execution
- AGY defaults to `--mode accept-edits`, no longer `--dangerously-skip-permissions`.
- `permissionMode`: `accept-edits` (default), `plan`, `auto`, `full-auto`. Only explicit `full-auto` uses `--dangerously-skip-permissions`.
- Both `delegate` and `session.create` reject attempts to smuggle AGY mode/unsafe flags through the general `args` list.
- The MCP server and in-agent tool both surface the permission field; custom CLI flags retain their current semantics.

### Long-running bridge and progress
- `delegate.start` creates a pollable background job. `delegate` with `wait:false` now selects the same behavior rather than ignoring the flag.
- New AGY background launches use `--output-format stream-json`. Parsed `init`, `step_update` and `result` events expose safe stage labels, activity counts and last-progress timestamp.
- Background jobs persist periodic **bridge-owner** heartbeats and last-CLI-output timestamps. No CLI output for 60 seconds is a diagnostic, not proof of a hang.
- `delegate.get` and `delegate.health` surface heartbeat, last output, stage and silent counts. `delegate.tail` now reads a bounded log tail instead of loading the whole file.

### Cross-process capacity and retry
- Host-local numbered concurrency slots are acquired with atomic directory creation, have random owner tokens, and are released only with a matching token. Slot metadata includes job and PID for local operator diagnosis, but MCP `delegate.slots` shows **only occupancy**, not another project's ID or PID.
- Unknown or orphan slots are intentionally not auto-removed. Use process identity and child-process inspection before any manual cleanup. Slot root defaults to OS temp `superagent-cli-bridge-capacity-v1`. Operators running multiple instances must configure consistent `SUPERAGENT_CLI_BRIDGE_MAX_JOBS` and, when overriding, the same `SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR`.
- Optional `idempotencyKey` prevents accidental repeated dispatch of the same request in the same workspace using the saved request digest. Changed CLI/prompt with the same key fails closed.
- `delegate.retry` requires a fresh prompt and a terminal original job. This is **not automatic crash reattachment**.

### Logs and security
- The synchronous delegator stores only a prompt length and SHA-256 digest instead of the raw prompt.
- Common credential patterns are best-effort redacted from new CLI logs and output. This does **not** guarantee that every user-defined secret can be detected.
- Workspace access, file/asset evidence, read-only recovery and no-PID-only automatic unlock remain enforced.

## Commands

The MCP tool is `superagent_cli_bridge`; examples below show its `action` fields:

```json
{"action":"delegate.start","cli":"agy","prompt":"Implement feature and run tests","permissionMode":"accept-edits","timeoutMs":1800000,"idempotencyKey":"feature-20261022-v1","expectedArtifacts":["docs/plans/feature.md"]}
{"action":"delegate","cli":"agy","prompt":"Long-running refactor","wait":false}
{"action":"delegate.get","jobId":"<returned jobId>"}
{"action":"delegate.tail","jobId":"<returned jobId>","tailLimit":200}
{"action":"delegate.health"}
{"action":"delegate.slots"}
{"action":"delegate.retry","jobId":"<completed jobId>","cli":"agy","prompt":"Continue from verified files and run tests"}
{"action":"delegate.cancel","jobId":"<returned jobId>"}
```

`expectedArtifacts` must be actually created or changed. A process exit code 0 without this evidence remains an **unverified** success.

## Verification

- `bun x vitest run tests/cliBridge*.test.ts --maxWorkers=1`: 9 files, 107 tests passed.
- `bun x tsc --noEmit --pretty false`: passed in the validated checkout.
- Tests cover AGY permission defaults, background `wait:false`, heartbeat and streamed stages, idempotency, controlled retry, host-wide slot acquisition/release and ownership tokens, credential redaction and bounded tail reads, workspace isolation, artifact proofs, and recovery.

## Remaining limitations / operating cautions

1. A running foreign CLI process whose original bridge owner crashed cannot be safely reattached or killed by PID alone; recovery remains diagnostic/manual. Automatic reattachment is not claimed.
2. Even with host-wide capacity, concurrency does not prevent **all** edits from conflicting in one workspace; use separate worktrees or explicit, non-overlapping `expectedArtifacts`. It cannot account retroactively for tasks launched by an older runtime.
3. New AGY structured progress requires a newly launched delegation, an AGY version supporting `stream-json`, and the CLI actually emitting events. Other providers may only report stdout and bridge-owner liveness.
4. Host-local capacity is not distributed across different machines.
5. Pattern-based output redaction is best-effort; do not place high-value secrets in LLM prompts or verbose tool output.
6. The running MCP server must reload/restart to publish its expanded tool schema. Do this only when no critical live tasks depend on the old server.
7. A dedicated Gemini CLI profile has not been integrated; custom CLI execution remains available.
8. `delegate.retry` does not revalidate all downstream business requirements. Verify build, tests, Git diff and completion evidence before approving a change.

## Follow-up acceptance goals

- Versioned structured MCP response objects alongside backward-compatible text.
- Explicit workspace lock scopes for write-capable delegations and a safe worktree coordination protocol.
- Provider-neutral normalized progress events for Claude and Codex.
- Manual supervised orphan-capacity cleanup with operator-reviewed PID start-identity and child tree proof.
- CLI API telemetry dashboards and secure log-retention controls.
