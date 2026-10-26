# R3–R7 — Independent ingress, recovery and production rollout gate

**Date:** 2026-10-26. **Production status: BLOCKED / NO CUTOVER**. Staging-side work does not imply an approved production migration.

## R3 — independently owned MCP ingress (isolated test)

Source: src/core/runtime/mcpIngressStage.ts and mcpIngressCli.ts.

The opt-in CLI process can attach only to a separately verified Windows TCP owner PID on a different loopback port:

    SUPERAGENT_MCP_INGRESS_STAGING=1
    SUPERAGENT_CORE_STAGING=1
    SUPERAGENT_SENOPATI_AUTOSTART=0
    bun dist/cli.js mcp ingress-stage --listen-port TEST_PORT_B --target-port TEST_PORT_A --target-pid VERIFIED_TEST_PID

It checks the target OS listener owner when attaching and on each proxied request, forwards only specific OAuth discovery/authorize/token/register and MCP paths, refuses the private owner control and Core API, never creates a tunnel or publishes public URLs, and has an independently stoppable process identity. The issuer and protected resource metadata continue to name the OAuth target, not the proxy port: this is **not** a transparent new public OAuth endpoint. It has no TLS, rate-limiter, signed edge identity or provider reconnect protocol. Do not expose this canary ingress.

Run bun scripts/verify-independent-oauth-stage.ts for 19 live checks, including actual PKCE S256 consent/token exchange, wrong-verifier rejection, issuer process restart with persistent refresh rotation, exact token replay rejection, independent ingress PID, internal-route denial, and unchanged production listener PIDs.

## R5 — Windows recovery safety

Source: src/core/runtime/runtimeColdRecoveryR5.ts plus existing coreBoot.ts, coreWindowsStartup.ts and setup-core-windows-startup.ts.

The new cold-reboot preflight explicitly distinguishes verified/absent/stale Core, MCP and ingress owners, broken OAuth persistence, PID reuse and unresolved external side effects. Any unknown/malformed evidence -> manual review; even a clean stage plan does not authorize production restart, session import or tool replay.

Safe preview, with NO task installation:

    bun scripts/setup-core-windows-startup.ts --port 7888

Do not use --apply against the legacy 7888 owner while Core and live MCP share PID. Windows per-user logon provisioning and hardware reboot are separately approved, disruptive operations and were NOT performed during this phase. The current Core Boot already fails closed for dead workers and stale checkpoint state; this phase does not change or clear them.

## R6 — staged release evidence

Sources: tests/mcpDurableOAuthR2.test.ts, tests/mcpIngressStageR3.test.ts, tests/runtimeReleaseGateR5R7.test.ts, scripts/verify-independent-oauth-stage.ts, core-guardian workflow. T-Line backend owner routing contract is separately documented in its docs/guides/runtime-supervised-routing-r4.md.

The release gate requires independent owner identity, real OS keystore/ACL and TLS certification, installed T-Line native app E2E, multi-workspace/reconnect chaos, extended 24–72h soak, zero unknown effects, legitimate external client reauthorization, drain and reversible routing. Local unit and short staging canary tests cannot certify any of those unperformed long-running/external milestones. Remote GitHub CI results are not verified by local execution.

## R7 — read-only live rollout blockers

    superagent core ownership-inventory --port 7888
    superagent core rollout-audit --port 7888

The gate never imports old OAuth tokens, authorizes an automatic endpoint change, sends PID signals, accepts unreconciled tool effects or concludes that a staging success allows production migration. A complete certificate could at most permit an operator-reviewed, explicitly approved client-by-client canary with rollback. The legacy API Core 7888 and MCP OAuth 6789 were observed on the SAME PID 13424; MCP OAuth 9877 was a separate owner. The live report is therefore blocked. Re-run the inventory immediately before any maintenance action because these PIDs may change.

### Remaining release-critical work

Production R2: OS protected credential/key store (Windows DPAPI or supported native keystore) and durable transactional OAuth state/rotation, auditable client registration controls, TLS issuer identity and backup/restore. R3: provider-specific independently owned ingress/tunnel with live issuer parity, authenticated proxy trust and drain. R4: installed T-Line desktop E2E. R5: opt-in separate per-owner Windows reboot/autostart drill on a test system. R6: actual extended soak, Linux/Windows CI completion and security threat model. R7: human-controlled client reauthorization and reversible public routing, confirmed 0 active legacy sessions and 0 ambiguous tool effects, then separate Core 7888 cutover. None of these may be misrepresented as completed on production by green local tests.

Status labels: R2 staging functioning, R3 staging functioning, R4 source/backend contract verified, R5 safety preflight implemented, R6 partial automated staging evidence, R7 real-time blocker audit implemented; production release blocked.
