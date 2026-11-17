# Parallel MCP Agent Work — CLI Bridge operator contract

This describes the **source implementation**, not a production rollout or
proof that a currently installed Tray/MCP backend has been updated.

## Independent agent scheduling

- Each initialized, authenticated MCP transport has an **opaque, trusted
  per-session owner key**. A stateless MCP request has no trustworthy
  per-agent session identifier, so stateless requests sharing an authenticated
  credential share a conservative owner-admission bucket.
- T-Line jobs use the trusted server-originated T-Line session provenance.
  Client-supplied `agentId`, `role`, `clientInfo`, prompts and tool arguments
  **cannot create or change** owner identity or access grants.
- Default host capacity is four delegates (adaptive 2–8), with a default of
  **two active jobs per verified agent**, **four per CLI adapter**, and
  **four per project**. Existing direct unattributed local launches retain
  their previous admissions; host/project/adapter caps still apply.
- Optional environment configuration on the trusted owner process:
  `SUPERAGENT_CLI_BRIDGE_MAX_JOBS` (1–8),
  `SUPERAGENT_CLI_BRIDGE_PER_AGENT_QUOTA` (1–8),
  `SUPERAGENT_CLI_BRIDGE_PER_CLI_QUOTA` (1–8),
  `SUPERAGENT_CLI_BRIDGE_PER_PROJECT_QUOTA` (1–8).
  These are capacity settings, **not** authentication or host permission grants.

## Running agents in parallel

1. Establish distinct authenticated **stateful** MCP sessions for independent
   agents; assign each one specific, nonoverlapping file scopes.
2. Call `superagent_cli_bridge` with `action: "delegate.start"`,
   `queueIfBusy: true`, a bounded timeout, scoped cwd/workspace, and
   `expectedArtifacts` or explicit `resourceClaims` when writing files.
   A job returns a job ID; monitor with `delegate.get` and `delegate.tail`.
3. Read `delegate.agents` for **workspace-scoped aggregate** running/queued
   counts without identities, paths or prompts. Read `delegate.slots`
   for host-wide aggregate slot/limit diagnostics without foreign PIDs.
4. If a project, adapter, owner or artifact claim is busy, the queued job
   waits; other eligible agents can still be admitted. A queued job enters
   `starting` **before** async launch to reserve capacity correctly.
5. For code editing, isolate change scopes. Opt-in worktrees only where
   appropriate and authorized; this update does not automatically create,
   delete, merge or switch branches.

## Security and lifecycle boundaries

- Each MCP tool invocation still passes OAuth scope, project capability,
  host policy, safe-only tool restrictions and explicit Security Approval.
  Chat Agent YOLO **never grants MCP access**.
- Quotas and fair scheduling are local to the CLI Bridge runtime; cross-process
  capacity leases and file/resource claims provide separate host-wide limits.
  Fair scheduling is not a new security identity or authorization primitive.
- No live MCP sessions, OAuth tokens, public tunnel, Core process or active
  delegate are restarted, transferred or replayed by these changes.
- All independent jobs can still compete for CPU/RAM; adaptive host pressure
  reduces admission without terminating running work. There is no guarantee
  of simultaneous service at full host saturation.

## Verification

Focused source tests:
`tests/cliBridgeAgentOwner.test.ts`,
`tests/cliBridgeAdaptiveScheduler.test.ts`, plus the existing
`tests/cliBridgeLiveMultiAgentE2E.test.ts` when the required CLI/host
dependencies are available. Actual installed-host and platform CI results
must be checked separately before making a production claim.
