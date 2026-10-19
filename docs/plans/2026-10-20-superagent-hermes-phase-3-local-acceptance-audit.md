# Hermes-Style Phase 3 — Final Local Acceptance Audit

**Date:** 2026-10-20
**Branch:** `main`
**Status:** Implementation and local regression acceptance complete; **not production-certified** pending external integration gates.

## Source and execution boundary audit (TASK-307)

All source invocation paths identified in `src/` are funneled into the same scheduler:

| Entry point | Source | Execution entry | Enforcement |
| --- | --- | --- | --- |
| Direct CLI | `src/core/daemon/daemonCli.ts` | `daemonScheduler.triggerJobNow()` | `executeJob()` |
| Interactive `/daemon` | `src/core/commands/daemonCommand.ts` | `daemonScheduler.triggerJobNow()` | `executeJob()` |
| REST `POST /api/daemon/jobs/run` | `src/core/daemon/daemonRoutes.ts` | `daemonScheduler.triggerJobNow()` | `executeJob()` |
| Scheduler tick | `src/core/daemon/daemonScheduler.ts` | Private `executeJob()` | Same executor and ledger |

The shared execution path records a durable ledger attempt, validates actual workspace paths and rejects symlink components before the runner, snapshots canonical workspace/project identity and approved skill version/hash, checks file lock contention, constrains default headless tools, and disables ambient YOLO authorization.

**Hardening completed during audit:**
- Job creation validates schema types at the shared constructor, including mode, bool flags, workspace, retry settings, tags, and tool-list shape.
- Public job updates only accept an explicit editable field allowlist; internal counters, status, job kind, creation metadata, and unrelated fields are rejected.
- Active jobs cannot change their workspace, pinned skill, tool grants, prompt, or execution configuration. Only `enabled` can be toggled without replacing the active job's object identity.
- Active jobs cannot be deleted out from under an in-flight run.
- Regressions assert denied cross-policy modification, preserved run count/policy in a disabled-while-running job, and no alternative manual execution route.
- The dedicated tripwire suite `tests/daemonEntryPointPolicy.test.ts` guards entry-point convergence; `tests/daemonScheduler.test.ts` checks actual runtime enforcement.

## Additional full-suite fixes

- The OpenAI Secure MCP Tunnel client now **fails closed on an explicitly invalid key**, instead of silently substituting an environment or saved credential.
- The `get_muse_direct_chat_readiness` tool, present in tier toolsets, is registered in the canonical registry.
- Remote Agent tests reflect the intentional separation of `/muse` task/WebSocket operations and `/telegram` credential ownership; autocomplete descriptions for Muse runner mode were completed.

## Verification evidence

- `bun run build` — **passed**.
- `bun run verify:extension-js` — **passed**, 8 JavaScript files.
- Full Vitest run (`bunx vitest run --reporter=default --maxWorkers=4`) — **exit 0**, **364 passed suites**, **1 skipped suite**, **3,506 passed tests**, **5 skipped tests**, **0 failed**, captured before the final two TASK-307 test cases and static entry-point suite were added.
- Final post-hardening focused run (including scheduler, entry-point tripwire, daemon REST/MCP, OpenAI Tunnel, tool registry, skill learning/revisions/retention/tracking) — **101/101 tests passed across 11 suites**.
- `git diff --check` — passed.

**Do not add the full-suite and focused test counts together**: they overlap.

## External acceptance still required

1. **RMemory live gateway:** Effective local configuration is missing `rmemoryGatewayApiKey`; read/write through a real gateway, owner review, negative feedback, and recall isolation could not be certified with real credentials. Local in-memory/mock integrations pass.
2. **Live LLM/provider skill replay:** Running an actual provider-backed replay, user approval, and pinned daemon execution in production-like infrastructure remains an external E2E gate.
3. **MCP OAuth/client grant:** Tool registration/workspace cross-project regressions pass locally. A real OAuth-backed external MCP client project-grant probe has not been completed.
4. **Operational staging:** Run post-deploy smoke checks on the intended server/platform, verify daemon restart/crash behavior with the configured gateway and transport, and review the 5 intentionally skipped tests before release.
5. **Credential hygiene:** A previous failing test emitted credential material into a temporary assertion log. Such logs must be removed and any exposed credential should be rotated in its provider settings.

**Release decision:** Phase 3's bounded code implementation and local regression gate are complete. Overall Hermes-style migration and production readiness **remain pending** the external gates above. No unattended approval or promotion of new skills is allowed.
