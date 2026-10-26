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

### R3 private-ingress proxy trust hardening (2026-10-26)

The private staging ingress now strips untrusted forwarded/original/real client
identity and hop-by-hop proxy headers, replacing Host with the kernel-verified
loopback target. OAuth bearer, MCP session and content headers remain intact.
R3 negative tests and the 20-check independent OAuth/ingress process smoke pass.
This change does not provision TLS, resolve public issuer parity, or permit
production tunnel cutover.

### R3 exact public issuer/resource metadata parity preflight

A new read-only check in src/core/runtime/mcpPublicIssuerParityR3.ts
compares observed OAuth discovery and protected-resource metadata to an
explicit new public HTTPS issuer, including PKCE S256, resource audience,
registration/authorize/token URLs and the protected MCP resource. Mismatch
blocks a migration review. Even a parity success is only a metadata review
candidate: it does not prove TLS ownership, real provider connectivity,
live sessions, approved cutover, or allow endpoint mutation. Tests live at
tests/mcpPublicIssuerParityR3.test.ts and run in the R6 CI matrix.

### R5 cold-recovery adversarial matrix

tests/runtimeColdRecoveryMatrixR5.test.ts covers reboot uncertainty, unknown
external effects, stale/reused Windows PIDs, dead checkpoint workers, missing
OAuth key, corrupt owner records and malformed effect counts. Fail-closed
predicates never authorize production restart, session restoration or tool
replay. This is a policy test, NOT a physical Windows reboot, task registration
or proof of successful recovery after power loss.

### R5 startup-registration safety hardening (2026-10-26)

The per-user Task Scheduler helper remains **PREVIEW ONLY** by default.
Its `--apply` mode now refuses all legacy ports 6789/7888/9877 and
requires a pre-existing isolated staging profile inside
`~/.superagent-local-staging/<dedicated-profile>`, passed as `--profile`.
The launcher explicitly sets `SUPERAGENT_CONFIG_DIR` to that profile,
`SUPERAGENT_CORE_STAGING=1`, and disables auto-start of the local model.
A registration is refused when OS port ownership cannot be read, another
process owns the port, an identically named task exists or Task Scheduler
cannot be queried, or the isolated cold-start audit cannot prove a fully
empty fresh namespace. A second listener check occurs just before task
registration. The guard does not create a Windows task itself; it only
permits the existing `--apply` path to proceed.

Read-only preview:
`bun scripts/setup-core-windows-startup.ts --port 7903 --profile <absolute-existing-private-stage-directory>`
No task was registered in the 2026-10-26 engineering verification.
Real reboot/power loss and production startup/cutover remain separate
uncertified operator-held tasks. Tests:
`tests/coreWindowsStartupRegistrationR5.test.ts`.
