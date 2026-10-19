# OpenAI Secure MCP Tunnel Hardening Plan

Date: 2026-10-19
Status: In progress — credential/readiness hardening and provider-conflict guards implemented; status observability and real tunnel verification remain.
Scope: SuperAgent OpenAI Secure MCP Tunnel integration only

## Implementation Progress (2026-10-19)

Implemented in the working tree:
- Removed silent fallback from the tunnel runtime key resolver to `OPENAI_API_KEY` and the ordinary OpenAI model-provider credential.
- Made startup require successful `/healthz` and `/readyz` probes independently; health-only is no longer treated as ready.
- Added bounded startup diagnostics with explicit secret redaction and cleanup when startup fails to become healthy and ready.
- Added provider ownership guards so an active Cloudflare MCP server cannot be reused as OpenAI, or vice versa, on the same in-process port.
- Improved `/muse tunnel start --mcp` messaging when the active and requested providers differ.
- Added regression tests for the credential fallback and provider conflicts.

Validation completed:
- `bun run build` — passed.
- Focused Vitest run across OpenAI client, MCP tunnel lifecycle/integration, Muse message command, and slash commands — 5 files / 78 tests passed.
- `git diff --check` — passed.

Still outstanding:
- Extend status reporting with a current, verified OpenAI tunnel health/readiness view.
- Add direct startup-timeout/process-cleanup tests.
- Run the installed official `tunnel-client doctor --profile <profile> --explain` and perform a real safe MCP request. This requires a real tunnel ID and a dedicated runtime key with Tunnels Read + Use; no key or tunnel ID is embedded in this plan.

## Goal

Make SuperAgent's OpenAI Secure MCP Tunnel setup, startup, status reporting, and recovery accurate and safe. The objective is to verify the actual OpenAI tunnel-client path rather than confuse it with the Cloudflare Quick Tunnel used by Muse and the default MCP tunnel provider.

## Confirmed Code Locations

- `src/core/mcp/openaiTunnelClient.ts`
  - Finds and supervises `tunnel-client`, resolves credentials, writes profile YAML, runs `doctor`, polls the local readiness endpoints, and persists process state.
- `src/core/mcp/mcpTunnel.ts`
  - Chooses Cloudflare or OpenAI provider, starts/stops the local MCP HTTP server and OpenAI tunnel-client, and records MCP state.
- `src/core/commands/museTunnelSubcommand.ts`
  - Supports `/muse tunnel start --mcp --provider openai --tunnel-id <id>`, plus `--doctor`, `--profile`, and `--api-key`.
- `src/core/commands/mcpCliHandler.ts`
  - Supports `superagent mcp tunnel start|stop|list|doctor`.
- `tests/openaiTunnelClient.test.ts`
- `tests/mcpTunnelOpenAiIntegration.test.ts`
- `tests/mcpTunnelLifecycle.test.ts`

## Audit Findings

### P0 — Credential resolution can choose the wrong kind of key

`resolveOpenAiControlPlaneKey()` currently tries, in order, an explicit key, `CONTROL_PLANE_API_KEY`, a configured OpenAI model-provider key, and `OPENAI_API_KEY`.

OpenAI Secure MCP Tunnel needs a runtime key with Tunnels Read + Use. A general model-provider key is not proof of tunnel permission and should not be silently treated as the tunnel runtime credential.

Required behavior:
- Accept an explicitly supplied tunnel runtime key or `CONTROL_PLANE_API_KEY`.
- Do not silently fall back to `OPENAI_API_KEY` or the general OpenAI model-provider credential.
- Return an actionable error that names the expected environment variable and required tunnel permission, without printing the key.
- Keep secrets out of the profile file, persistent state, logs, and diagnostic output.

### P0 — Startup may report a healthy tunnel when readiness was never confirmed

`startOpenAiTunnel()` waits for `/readyz` and then `/healthz`, but after the deadline it still registers the child process and persists a status with `healthy: true`, even when `isReady` is false. This can present a running-but-not-ready process as healthy and leaves an ambiguous failure state.

Required behavior:
- Only report healthy after a successful health probe and ready after a successful readiness probe.
- If the child exits or the startup deadline expires before the required startup checks pass, collect a bounded, sanitized diagnostic, stop the child, remove transient/persisted state, and fail startup clearly.
- Avoid orphaned tunnel-client processes and stale JSON state on every startup failure path.
- Keep the health checks loopback-only by default.

### P1 — MCP start can obscure provider mismatch

The slash-command start path returns “MCP server is ALREADY ACTIVE” whenever any MCP server is already registered on the selected port. It does not explain whether the active provider is Cloudflare or OpenAI, even if the user explicitly requested OpenAI.

Required behavior:
- When the requested provider conflicts with the active provider, report both the active and requested provider, include the active port and owning PID/workspace where available, and explain the safe stop/restart command.
- Do not stop a server owned by another process automatically.
- Preserve the current safe behavior that prevents two providers from owning the same MCP port.

### P1 — OpenAI tunnel status needs to be visible and verifiable

The OpenAI tunnel client has detailed local state and an admin UI URL, but the general remote-status summary described by `superagent_get_remote_status` focuses on Muse/Cloudflare, MCP clients, and Telegram. This makes it easy to inspect the wrong tunnel when diagnosing connectivity.

Required behavior:
- Expose OpenAI Secure MCP Tunnel state separately from Muse's Cloudflare WSS tunnel.
- Include provider, tunnel ID, MCP local URL, tunnel-client PID/uptime, profile, and observed health/readiness when available.
- Distinguish process-alive, health-checked, ready, and connected/polling states; do not infer connectivity solely from a PID or state file.
- Redact credentials and avoid echoing bearer tokens.

### P1 — Startup argument/profile behavior needs verification against upstream CLI

The code generates a profile YAML and also passes explicit runtime flags to `tunnel-client run`. This is supported by upstream configuration precedence, but the exact flags, profile path behavior, and runtime-key semantics should be verified against the installed binary's `help quickstart`, `help doctor`, and `doctor --explain` outputs. Do not rely exclusively on assumptions encoded in the tests.

Required behavior:
- Keep profile and runtime flags consistent.
- Preserve user-provided profile data unless a deliberate overwrite/update was requested.
- Ensure profile names and IDs cannot escape the profile directory or inject YAML.
- Do not automatically install from an unverified package name; prefer the official platform download/latest release path if automatic installation cannot be verified.

## Implementation Phases

### Phase 1 — Credential and readiness correctness
1. Tighten `resolveOpenAiControlPlaneKey()` so only tunnel-specific credentials are considered.
2. Add regression tests for credential priority and refusal to fall back to the normal OpenAI model key.
3. Fix readiness/health reporting in `startOpenAiTunnel()`.
4. Ensure startup failure stops the spawned child and removes stale state.
5. Add tests for child exit, health-only, ready, timeout, and no-orphan behavior.

### Phase 2 — Command/provider diagnostics
1. Improve slash-command output for an already-active MCP server with a provider mismatch.
2. Keep ownership checks and avoid implicitly stopping another process's server.
3. Add command tests for OpenAI start, missing tunnel ID, missing runtime key, active Cloudflare conflict, doctor-only mode, and profile selection.
4. Ensure both CLI and slash-command surfaces report the same actionable guidance.

### Phase 3 — Status and operator workflow
1. Add OpenAI tunnel details to the dedicated status output, separate from Muse tunnel status.
2. Show `healthy` and `ready` only when backed by a current probe.
3. Add a concise operator runbook with startup, doctor, status, stop, and recovery commands.
4. Document the difference between `CONTROL_PLANE_API_KEY` and `OPENAI_API_KEY`, plus the Tunnels Read + Use requirement.

### Phase 4 — Validation
Run focused tests first:
- `tests/openaiTunnelClient.test.ts`
- `tests/mcpTunnelOpenAiIntegration.test.ts`
- `tests/mcpTunnelLifecycle.test.ts`
- the relevant slash-command / CLI handler tests

Then run:
- `bun run build`
- `bun run test -- <focused filters>` or the repo's supported Vitest equivalent
- `bun run verify:extension-js` only if the change touches extension assets

If a real tunnel is available, verify using the official client:
1. `tunnel-client help quickstart`
2. `tunnel-client doctor --profile <profile> --explain`
3. `tunnel-client run --profile <profile>`
4. Confirm local `/healthz`, `/readyz`, and `/ui`, then test a safe MCP tool call through the intended OpenAI surface.

A mock test does not count as proof that the real OpenAI control plane accepted the runtime key or that the tunnel is polling.

## Acceptance Criteria

- A normal model API key is never silently used as the Secure MCP Tunnel runtime credential.
- Tunnel startup cannot return a healthy status unless a health probe succeeds.
- Failed/not-ready startup does not leave an orphan child process or stale active state.
- Users can tell whether the conflicting active MCP service is Cloudflare or OpenAI and recover safely.
- Status differentiates process state, health, readiness, and verified connectivity.
- Secrets are not printed, logged, or persisted in state.
- Focused tests and TypeScript build pass.
- Documentation clearly separates OpenAI Secure MCP Tunnel from Cloudflare Quick Tunnel.

## Repository Safety Notes

At audit time, `task.md` was modified and `docs/plans/2026-10-20-superagent-hermes-like-phase-3-memory-and-autonomous-learning.md` plus `docs/reviews/` were untracked. They are pre-existing user changes and must be preserved untouched by this work.
