# Core / MCP OAuth Separation — P1–P5 Execution Evidence

**Date:** 2026-10-27 (Asia/Jakarta)
**Repository:** SuperAgent / main, source build 1.14.51 at execution time
**Scope:** operator-requested implementation and verification of P1 inventory/rollback, P2 independent OAuth, P3 independent Core Supervisor, P4 per-client migration, P5 production verification.
**Decision:** **STAGING ACCEPTED; PRODUCTION CUTOVER BLOCKED.** No legacy listener, MCP OAuth tokens, OAuth clients or shared external process was stopped, adopted or migrated.

## Verified current production topology (P1)

- Core: TCP `127.0.0.1:7888`, PID `19728` (`bun.exe`, installed `superagent/dist/cli.js`).
- MCP: TCP `127.0.0.1:8873`, OAuth, **same PID `19728`**.
- Registration: `legacy_or_foreign`, no authenticated Core Supervisor on 7888.
- Ownership decision: `shared_owner_do_not_cutover`; `canRestartCore=false`, `canStopMcp=false`, `canTransferOAuth=false`.
- Public MCP status exposed active Cloudflare endpoint through the legacy process. **Its address is intentionally omitted from this report** to avoid treating dynamic tunnel hostnames as canonical issuer identity.
- Read-only `core rollout-audit --port 7888` reports `blocked`. Unknown legacy sessions and external tool side effects are **unknown, not zero**.
- Untracked local files `build/`, `build_t42.ps1`, `fuzz_t42.ps1`, `p41*`, `p42*`, `suite_t42.ps1`, `t42_patch.py` were left untouched and are not part of this change.

**Rollback before cutover:** Keep legacy Core+MCP up; do not mutate client or OAuth configs, route, shared process, global port or credential store. Temporary staging owners from acceptance tests terminate only their own verified children.

## P2 — New independent OAuth owner, private staging (VERIFIED / production BLOCKED)

`bun scripts/verify-independent-oauth-stage.ts`: **20/20 live HTTP checks, exit 0**.

Verified newly isolated OAuth PID, Windows CurrentUser DPAPI-protected *new* issuer key, protected-resource/issuer discovery, client registration, PKCE S256 authorization and consent, rejection of bad verifier, token issuance, separate ingress process, 401 at ingress, blocked internal owner route, independent shutdown/restart, issuer persistence, refresh-token rotation and replay denial, successful MCP initialization after OAuth owner restart, immutable registered redirects, zero legacy-token import, and unchanged protected production listeners.

New issuer is **private loopback only**, has no public TLS tunnel or production OAuth migration authority. It is not the existing production OAuth client/issuer. Production requires certified service-account OS ACL and recovery, durable transaction semantics, public HTTPS issuer, hardened external ingress and real client reauthorization.

Regression tests for durable OAuth, Windows DPAPI, backup/restore, real OAuth HTTP and R3/R7 policies: **37/37 passed** after updating obsolete tests to respect the current YOLO OFF permission ceiling. No production permissions were elevated.

## P3 — Independent supervised Core and MCP lifecycle (VERIFIED / primary not cut over)

- `bun scripts/verify-core-mcp-owner-split.ts`: **24/24 Windows isolated acceptance checks, exit 0**. Authenticated Core supervisor and MCP owner use **different kernel listener PIDs**. Rolling restart replaced only test Core worker while test MCP PID/authentication continued, then test MCP owner restart did not stop Core. Staging test deliberately does not copy an OAuth session to a replacement server.
- `bun scripts/verify-managed-mcp-lifecycle.ts`: **17/17 checks, exit 0** for restricted local owner lifecycle, authenticated status, graceful drain/stop, nonce handshakes, no duplicate owner, no production process signals.
- The shared installed Core PID `19728` was not restarted, and the running MCP OAuth port `8873` was not replaced. The new build's CLI Bridge is **not certified active in the installed legacy PID**; explicit safe rollout remains necessary.

## P4 — Per-client OAuth migration (READINESS GATE ONLY; BLOCKED)

Policy test suite `runtimeClientMigrationR7.test.ts` and `runtimeReleaseGateR5R7.test.ts` is green. This proves denial safeguards, not external client migration.

Required evidence prior to individual approved cutover:
1. New **production** issuer has a stable verified HTTPS identity and discovery parity, independent process identity, persistent protected credentials, and validated backup/rollback.
2. Each external client explicitly reauthorizes with PKCE S256; its new audience, access token, refresh rotation and connectivity are checked **without copying legacy tokens**.
3. Confirm **zero** active old client sessions, **zero** unresolved external tool effects (not unknown); verify client-specific rollback.
4. Obtain separate approval for routing migration, then only after old MCP is drained and independent may the legacy combined PID be retired. Recheck kernel ownership, native desktop session reconnect and MCP availability first.
5. Do not alter the existing OAuth tunnel/endpoint or manually free the old ports merely to run a supervisor.

Read `docs/guides/runtime-r7-client-by-client-gate.md` and `docs/guides/runtime-r3-r7-release-gates.md`. Those policies already forbid automatic cutover and token transfer.

## P5 — Validation, monitoring and Core restart certification

**Code correction implemented:** `observe-runtime-soak-r6.ts` previously assumed old MCP ports 6789 and 9877. It now obtains **current registered MCP ports** from read-only state inventory and matches each to Windows OS TCP listener PID, rejecting absent, stale, duplicate or malformed records. The assessor accepts a validated explicit Core/MCP port set while preserving backward compatibility and failure-on-unknown semantics.

- `bun scripts/observe-runtime-soak-r6.ts 6 2`: exit 0; **4 samples over 6.33 s**, observed `[7888,8873]`; stable OS PID `19728` for both, no observation gaps. This is **process stability only, not independence**.
- `bun --bun x vitest run tests/runtimeReadOnlySoakR6.test.ts tests/runtimeReleaseGateR5R7.test.ts tests/runtimeClientMigrationR7.test.ts`: **21/21 passed**, including dynamically registered 8873 and invalid port-set rejection.
- `bun run build`: successful Bun/TypeScript build, exit 0.
- `bun scripts/verify-runtime-security-release-r6.ts`: exit 0, confirms **fail-closed** `productionCertified:false`, `releaseStatus:blocked` and `processSignalsSent:false`. This is NOT a passing production gate.

**Still unverified:** stable public TLS and external OAuth PKCE client migration, dedicated service-account Windows keystore and ACL, owner-independent installed native T-Line E2E, authenticated desktop handoff and reconnect, Windows reboot recovery in an approved private test profile, 24–72 hour soak, full CI and authorized reversible production change.

## Gates and follow-up status

| Phase | Current result | Can mark production DONE? |
|---|---|---|
| P1 inventory/rollback preparation | Live inventory captured and legacy protected; no production secrets exported | No — client/session inventory and rollback/cutover rehearsal still needed |
| P2 new OAuth process | 20/20 private OAuth/ingress real tests passed | No — production issuer/TLS/ACL unavailable |
| P3 supervised Core/MCP | 24/24 + 17/17 isolated acceptance passed | No — shared installed PID unchanged |
| P4 client migration | Policy guards verified, no external client migrated | No — external client reauthorization + drain required |
| P5 restart/certification | Observer fixed; six-second sample + build + tests passed | No — native, extended soak and production restart not performed |

**Do not run `free_port 7888`, `free_port 8873`, `taskkill 19728`, or `core restart --port 7888` on the currently unsupervised shared PID.** The supervisor intentionally refuses to adopt it.

**Next engineering gate:** build/validate an independently managed *production* OAuth owner with authenticated lifecycle, durable storage and public ingress; perform external client reauthorization/rollback and proven drain under an approved maintenance window. Only then authorize and exercise a supervised Core rolling restart while verifying MCP uptime.
