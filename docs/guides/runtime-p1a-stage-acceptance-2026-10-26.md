# G0 and P1-A — Live Windows independent owner restart acceptance

**Checkpoint date:** 2026-10-26
**Environment:** Windows user-private staging, no public TLS/tunnel, no production restart
**Release status:** STAGING_VERIFIED (partial G1A), **production BLOCKED**

## Baseline and change of observed legacy topology

The read-only inventory initially reported:

| Listener | OS PID observation | Authentication / interpretation |
| --- | --- | --- |
| Core 7888 | 38608 | Unsigned/unauthenticated supervisor; no right to restart |
| MCP 6759 | 45176 | OAuth state correlated to kernel PID; no drain proof |
| MCP 6789 | none | Stale recorded PID 13424, no live listener |
| MCP 9877 | 10060 | OAuth state correlated to kernel PID; no drain proof |

This supersedes the *observational* PID snapshot of Core 7888
and MCP 6789 sharing PID 13424; it does not supersede the safety
policy. A stale record is not a takeover grant and no legacy port
was moved. The live release gate still reports BLOCKED.

## Actual isolated Core/MCP experiment

Build: SuperAgent v1.14.37 compiled with Bun 1.4.2 before the script
extension and again after its implementation.

The existing `scripts/verify-core-mcp-owner-split.ts` starts only
fresh test processes with separate `SUPERAGENT_CONFIG_DIR` profiles
and random unused loopback ports. It verifies authentic Core control
status, kernel TCP listener ownership, MCP bearer isolation, and
safe-only tool policy before invoking a Core worker restart on that
exact private supervisor's authenticated control port.

| Test evidence | Actual observation |
| --- | --- |
| Stage Core public port | 62532 |
| Stage MCP listener port | 62533 |
| Stage Core supervisor PID | 47276 |
| Stage MCP independent owner PID | 49828 |
| Stage Core worker before restart | 49612 |
| Stage Core worker after restart | 39212 |
| HTTP owner authorization | MCP bearer accepted for GET without session, HTTP 400 rather than unauthenticated 401 |
| MCP PID and auth during Core worker roll | Unchanged |
| Protected legacy listener PID snapshots | 6759, 6789, 7888, 9877 unchanged |
| Stage cleanup | Both Core and MCP stage TCP listeners released |
| Test scripts | 16/16 split/restart; 17/17 managed MCP lifecycle |
| Focused R0/R1 policy regression | 5 files / 26 tests passed |
| Cross-domain R1–R7 regression after version bump | 20 files / 136 tests passed |

Report stored in the dedicated private local stage profile
`~/.superagent-local-staging/core-mcp-owner-EFTYhn/report.json`.
Do not commit credentials or use the report's numeric PIDs as permanent
ownership proofs. Both independent owners were temporary test processes;
they were stopped within the scope of the staging verifier.

## Fail-closed constraints and continuation

- Protected live listeners include the newly discovered port 6759,
  in addition to 6789, 7888 and 9877. A concurrent change to one
  protected PID invalidates the script's positive result.
- The real worker roll is permitted only after test Core/MCP kernel
  PIDs match the spawned canary and its authenticated private
  Core supervisor discovery; the script never calls restart on 7888.
- No OAuth token or session was migrated. No public ingress or DNS
  was created. No production process signal or scheduled task was sent.
- Stage cleanup proof is a point-in-time port snapshot; a new process
  might later bind the same ephemeral port.

**Remaining G1A:** operator-owned persistent Core/MCP stage,
versioned/private capability handshake from T-Line, full isolation
under MCP stop/restart while Core stays up, deliberate stale process
and PID reuse failure injection. **Remaining G1B:** certified independent
HTTPS ingress and real OAuth test client.

## Repeatable checks

```bash
bun run build
bun scripts/verify-core-mcp-owner-split.ts
bun scripts/verify-managed-mcp-lifecycle.ts
bun --bun x vitest run --maxWorkers=2 tests/runtimeOwnershipContract.test.ts tests/coreMcpOwnershipAudit.test.ts tests/mcpSafeOwnerR1.test.ts tests/mcpProcessBirthR1.test.ts tests/mcpOwnerControlR1.test.ts
bun src/cli.tsx core ownership-inventory --port 7888
bun src/cli.tsx core rollout-audit --port 7888
```
