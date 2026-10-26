# One primary SuperAgent runtime, optional temporary test profile

**Decision (2026-10-26):** Only one *primary* SuperAgent runtime serves
normal T-Line usage. A separate **temporary** SuperAgent test Core/MCP/OAuth
profile is created only when a migration, regression or fault injection
needs isolation. T-Line uses its normal ONE backend instance to reach
the chosen Core; T-Line does not need a persistent second staging backend.

The legacy primary Core and MCP processes may remain in place until
the R6/R7 release gates authorize the new independent owners.
Do not conflate "one primary runtime" with putting Core, MCP and OAuth
back into the same OS PID: the desired production architecture is ONE
runtime stack with independently owned Core/MCP/OAuth processes.

## Ownership and target selection

| Mode | Data profile | Core target | Lifecycle |
| --- | --- | --- | --- |
| Primary | `~/.superagent-r` or operator-owned primary profile | Existing authenticated primary listener; default 7888 | Normal operation |
| Testing | Fresh child of `~/.superagent-local-staging` | Separate operator-verified loopback port, never known live legacy ports | Bounded test or specifically supervised canary; removed after safe drain and OS identity verification |

The T-Line implementation is commit `bd82d89` (v1.3.739):
`TLINE_SUPERAGENT_RUNTIME=primary|testing` chooses the backend startup
target. In test mode its existing backend demands
`TLINE_SUPERAGENT_OWNER_MODE=supervised-external`,
`TLINE_SUPERAGENT_CORE_PORT=<new safe port>` and
`SUPERAGENT_CONFIG_DIR=<existing private test child>`. The same
backend then authenticates the Core owner and rejects absent/unverified
owners without spawning another runtime. No active-session hot-switch.
See the T-Line repository guide
`docs/guides/single-superagent-runtime-target.md`.

## Short-lived test acceptance

Windows live stage smoke at T-Line commit `bd82d89` passed 9/9 checks:
primary listeners unchanged, no T-Line backend instances spawned,
Core test owner OS PID matched its authenticated control plane, bogus
profile rejected, and private correct profile restored readiness.
The test-owned Core listener was released after the test.
The T-Line backend runtime selection/regression suite passed 25/25
cases. These are **staging-only evidence**, not installed-T-Line,
public HTTPS/OAuth certification or a production migration.

SuperAgent's existing checks remain:

```bash
bun scripts/verify-core-mcp-owner-split.ts
bun scripts/verify-managed-mcp-lifecycle.ts
bun scripts/verify-independent-oauth-stage.ts
```

Do not leave short-lived verifier processes behind. Any *persistent*
canary requires explicit owner lease, bounded observation, authenticated
drain, restart/recovery log and verified cleanup. Never stop a process
by guessed or stale PID, and never delete a profile while its owner
or uncertain external effects remain.

## Final simplification after approved migration

1. Prove R1–R6 credentials, public HTTPS, installed desktop, Windows
   recovery, long soak and signed rollback on independent owners.
2. Reauthorize and migrate external clients one by one under the R7
   authorization/zero-unknown-effects gate; no live token imports.
3. Make the certified new stack the **one primary SuperAgent** while
   retiring legacy owners through a separate approved maintenance window.
4. Close and verify test stage listeners; remove only safe, fully drained
   and operator-identified stage artifacts. Keep reproducible automated
   unit/integration tests for future releases.

**What this does not do:** install a new Windows Task Scheduler entry,
automatically move the active primary port, restart the installed desktop,
reroute external clients, delete unknown test profiles, or authorize
stopping any active legacy owner.
