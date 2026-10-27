# AGY CLI Bridge: headless permission recovery

Updated: 2026-10-27

## What changed
The bridge now detects structured AGY tool permission denials even when AGY exits with code 0. Such a delegation is reported as `permission_blocked` / `completionState=permission_blocked`, and the unified task is **failed**, not succeeded. The status preserves a separate warning when an account does not support `--mode auto` and AGY downgrades itself to `request-review`. `delegate.get` and `delegate.health` expose the diagnosis. Synchronous delegation reports `Status: PERMISSION_BLOCKED` if the structured result contains denied actions.

## Permission policy
- `permissionMode="plan"`: planning with default AGY protections.
- `permissionMode="accept-edits"` (default): may accept edits as permitted by AGY, but other commands can still need interactive review or a user-approved narrow allow rule.
- `permissionMode="auto"`: passed to AGY; some accounts **do not support it**. Do not assume it enables headless execution, and do not silently turn it into unrestricted mode.
- `permissionMode="full-auto"`: explicitly opts into AGY `--dangerously-skip-permissions`; only request it with the operator's separate explicit approval. The bridge never auto-upgrades or retries a denied command with more privilege.

When AGY prints `warning: --mode auto is not available for this account; continuing in the default mode`, noninteractive jobs may fall back to `request-review`. In this mode, a tool action needing approval **cannot be approved by a headless terminal**. AGY may return a successful process exit with a `denied_actions` array. This is **not** a completed implementation.

## Authorized recovery workflow
1. Call `delegate.get` or `delegate.tail` with the job ID in its original authorized workspace.
2. Identify the specific denied tool and exact operation. Do not reinterpret or attempt the denied action through an alternate command/tool.
3. Use an interactive AGY session or ask the operator to approve a **narrowly scoped** `permissions.allow` rule in AGY's settings for that action. Do not make global wildcard or unrestricted grants.
4. Once approved, submit a fresh `delegate.start` request with `permissionMode="accept-edits"`, a **new** idempotency key, and concrete `expectedArtifacts` when available. A past denied job is never automatically retried.
5. Verify job status, artifact checks, tests and git diff. Process exit zero alone is not proof of success.

Example parameters to a future approved invocation:
```json
{
  "action": "delegate.start",
  "cli": "agy",
  "projectId": "superagent",
  "permissionMode": "accept-edits",
  "expectedArtifacts": ["docs/implementation-report.md"],
  "idempotencyKey": "approved-task-v2",
  "prompt": "Carry out the approved task and produce the expected artifact."
}
```
The example is illustrative, **not** permission to run any previously denied command. Do not restart production Core/MCP to install the patch; use the established, explicitly authorized release/restart process. Existing live tool owner may still run previously loaded code until it is reloaded.

## Verification
- Parser tests verify account-mode warning, structured denied tool events, final `denied_actions`, and ordinary success.
- Background integration test uses a fake AGY NDJSON producer that exits 0 with denied actions; expected status is `permission_blocked`, not `succeeded`.
- Test capacity is isolated per test process and does not release/reclaim real AGY jobs' host-wide leases.
