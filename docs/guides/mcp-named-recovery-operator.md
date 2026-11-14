# MCP Named Tunnel recovery — operator dry-run guide

**Status:** design/preview only, 2026-11-14. No installed service, scheduled task, launch agent, DNS modification, machine reboot, credential rotation, endpoint cutover or live connector evidence is produced by this work.

This guide covers the **remote-managed** Cloudflare Named Tunnel profile already owned by native Tray; it does not create a second profile store. The code is `src/core/runtime/mcpNamedRecoveryPlan.ts` and the tests are `tests/mcpNamedRecoveryPlan.test.ts`. Do not infer that a green unit test makes a production service safe.

## Boundary and provenance

- Preview: `renderMcpNamedRecoveryPreview({ platform, tunnelId, hostname, anchorPort, ownerPort, cloudflaredPath, tokenFilePath })`. This is a lexical **cross-platform template**, not evidence that a private token, binary, service or native ACL exists. `verifiedLocalProfile` is always false.
- Native read-only preflight: `planMcpNamedRecovery({ root, expectedTunnelId, expectedHostname, platform })`. The target platform **must equal the running host OS**, and it reuses `readRemoteManagedNamedProfile` and `verifyRemoteManagedNamedProfile`, checks exact hostname/UUID, absolute and non-symlink local paths, hardlink protection, token private directory, restricted POSIX token modes, and protected port exclusion. No state is stored and no process is started.
- Every returned plan has `mode: "dry-run"`, `automaticActivation: false`, `productionAuthorized: false`, `nativeDependencyVerified: false`, `nativeCredentialAclVerified: false`, `requiresOperatorReview: true` and explicit blockers. Native credential ACL verification and owner/Anchor process birth identity are deliberately **not** inferred from a successful file read.
- Expected URL is `https://<verified hostname>/mcp`, but DNS, TLS, route ownership and client reauthorization are **not** proven by the plan.
- The connector process argv is four separate elements: `[cloudflared executable, "tunnel", "run", "--token-file", private token path]`. Neither `--token`, raw token bytes, `sh -c`, `cmd /c` nor `powershell -Command` is produced. Never copy a token into a command, environment variable, log or CLI history. Cloudflare documents `--token-file` for remote-managed tunnels from cloudflared **2025.4.0 or newer**: https://developers.cloudflare.com/tunnel/reference/run-parameters/. The current binary version still needs independent native verification.

## Safe boot/recovery dependency order

1. **MCP owner**: authenticate the exact dedicated private owner PID plus process birth identity; confirm owner port, trusted nonce/OAuth state, no replay, safe tool permissions, session drain and persisted state. Do not adopt an old PID, another listener or an unknown owner.
2. **Anchor**: ensure a separately authenticated Anchor serves only loopback and can reach that exact MCP owner. Confirm Anchor port, process birth identity, external-named mode and owner routing; do not let Anchor launch or take over a Quick Tunnel.
3. **Named connector**: only after (1) and (2), validate the imported private token's tunnel UUID and the attested cloudflared executable; inspect connector lease and ownership to prevent duplicate or spoofed processes. DNS/public TLS and external client reauthorization are separate downstream steps.
4. **Recovery limit**: on unknown side effects, broken lease, owner/Anchor mismatch or failed token ACL check, **quarantine the named recovery** and preserve the existing working route. Never restart both owner and connector blindly or replay external MCP calls.

The Windows and macOS preview formats cannot enforce readiness of an arbitrary live MCP owner/Anchor by themselves. The Linux unit refers to **proposed** `superagent-mcp-owner.service` and `superagent-mcp-anchor.service` names; those units are not asserted to exist. Every platform must fail closed until real service identities, ordering and health dependencies are certified.

## OS-specific artifacts (not installed)

| OS | Generated template | Security/recovery guard | Native certification still missing |
| --- | --- | --- | --- |
| Windows | `SuperAgent-McpNamed-Recovery.xml` Task Scheduler XML | Disabled logon trigger, disabled task, least-privilege interactive principal, ignore concurrent instances, quoted token-file path in XML-safe arguments; no shell | Task XML import/registration rehearsal under the intended SID; token, parent directories and executable ACL/owner verification; run-as identity, logon trigger behaviour, owner/Anchor readiness and real reboot/rollback |
| macOS | `com.superagent.mcp-named-recovery.plist` launchd LaunchAgent | Discrete `ProgramArguments`, disabled, no `RunAtLoad` or `KeepAlive`; no shell | plist validation on macOS, user-session and TCC/permissions, actual owner/Anchor ready check, entitlement/signing, native reboot and recovery evidence |
| Linux | `superagent-mcp-named-recovery.service` systemd **user** unit | `Requires` and `After` for proposed owner/Anchor units and network, `Restart=on-failure` with limited start burst, private umask, no install/enable section; token environment unset | Real unit existence/identity, `systemd-analyze verify` on target distro, systemd user linger policy and credential sandbox/SELinux/AppArmor, installed restart/rollback tests |

All artifacts are **strings returned to the caller**, not files written by the planner. The suggested artifact names are not a request to save them under `/etc`, `/Library`, Task Scheduler or any configuration directory.

## Operator-only manual review sequence

1. Keep existing Core, MCP, Tray, Anchor, Quick Tunnel and named connector processes running untouched. Read Git status and native ownership inventory first; preserve other delegates' dirty files and active sessions.
2. Confirm Cloudflare account, expected hostname and exact tunnel UUID against trusted administrative records, independently of a user-provided string. Confirm the DNS route and TLS configuration by read-only, externally observed checks; never assume URL parity from a template.
3. Check `cloudflared --version` on the target OS without starting the tunnel; require token-file support. Inspect canonical executable identity and signature/hashes. Inspect real token-file and every parent directory's ownership and ACL; on POSIX require mode `0600` for token and `0700` for the private directory; on Windows inspect inherited ACEs/owner SID explicitly. Never output token content.
4. Call native `planMcpNamedRecovery` for that host with pinned expected UUID and hostname. Reject any error or any unresolved blocker. Do **not** treat cross-OS preview output as permission to install.
5. Independently inspect whether a Scheduled Task/launchd label/systemd unit with the same identity already exists. Conflicts, unknown leases, existing external service ownership or missing owner/Anchor dependencies stop the process.
6. In a separately approved **disposable test profile** with dedicated non-production ports, review the generated artifact byte-for-byte, prove process identity and recovery order, test actual login/reboot and service-failure recovery, revoke and restore safely, record event/exit evidence. The planner itself cannot perform these steps.
7. Only after the R0–R7 gates below and explicit operator approval may a separate privileged deployment implementation be designed. There is **no apply API** here, and no example install/enable command is provided to avoid accidental cutover.

## R0–R7 release gates (all remain unverified by this planner)

| Gate | Required operator evidence before production |
| --- | --- |
| **R0** | One primary stack, accurate ownership inventory, no legacy PID adoption, no unreviewed endpoint disruption |
| **R1** | Independent MCP owner with verified safe-tool permission boundaries, authenticated status and no implicit replay |
| **R2** | OAuth/PKCE token persistence, native keystore and credential ACL audit, tested private backup/restore |
| **R3** | Exact named hostname, TLS, DNS, edge routing, issuer/resource/redirect parity and non-overlapping tunnel ownership |
| **R4** | Installed desktop/T-Line app verification and reconnection/session tests on the target OS |
| **R5** | Actual native reboot/power-loss and owner/Anchor/connector recovery with stale PID/lease and failure-injection evidence |
| **R6** | Native Windows, macOS and Linux CI + host smoke, soak (24–72h), checksums/signing and recorded approval |
| **R7** | Client-by-client PKCE reauthorization, drain/zero old sessions, external-effect reconciliation, verified rollback and written operator approval |

For the canonical runtime release criteria see `docs/guides/runtime-r0-r7-2026-10-26-evidence.md` and `docs/guides/release-incident-playbook.md`. Earlier historical R0–R7 records are not evidence that this newly generated recovery artifact is installed or production-certified.

## Rollback / incident containment

- Treat credential-path changes, owner PID ambiguity, stale process leases, partial boot, ingress outage or failed TLS checks as an incident; do not auto-retry a destructive or unknown-effect operation.
- Quarantine only the **separately authenticated named connector** in an approved native incident procedure; never stop another process by PID alone. Do not touch the Quick Tunnel merely because the named connector is unhealthy.
- Preserve the last verified independent MCP owner, Anchor and current public URL. Do not replay POST/tool calls or silently swap OAuth clients/issuer/hostname.
- Require human review and independent native evidence before restoring anything; R7 requires a reversible client-by-client rollback plan.

## Test evidence and limits

`bun --bun x vitest run tests/mcpNamedRecoveryPlan.test.ts --maxWorkers=1` covers the three platforms, XML escaping, no token leak, protected ports, UUID/hostname, spoofed paths, shell injection, cross-platform refusal, disabled activation, rollback guards and expected-identity mismatch. `bun --bun x tsc --noEmit` checks TypeScript. Capture the **actual current command exit codes** in the integration report; this document intentionally makes **no claim of real reboot, service installation, DNS health, native OS CI, release publication, or live deployment**.
