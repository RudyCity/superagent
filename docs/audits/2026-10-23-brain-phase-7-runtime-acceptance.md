# Brain Phase 7 — Runtime Reliability, Operator Recovery and Release Acceptance
Date: 2026-10-23. Repositories: SuperAgent Core + T-Line.

## Implemented in source
- **7A: Evidence-bound launch recovery.** A Brain task launch reservation is persisted before CLI dispatch and its one-time random token becomes a per-task CLI Bridge `idempotencyKey`. Each task launch path (CLI / MCP autostart / MCP delegate / MCP retry) forwards this key. `brainLaunchRecovery.ts` inspects persisted Bridge shards, rejecting missing, forged, mismatched-cwd and conflicting job evidence. There is **no** automatic unlock/retry when acknowledgement is missing. Explicit operator confirmation attaches a uniquely matched job and clears the reservation, logging a bounded redacted recovery event. Historical reservations created without an idempotency key remain `legacy-unknown` and require manual triage.
- **7B: Task lifecycle guard.** Terminal task status now refuses any unresolved launch reservation, any still-active session Bridge process, and any missing/mismatched/unverified persisted Bridge evidence for recorded task jobs. Transfer is refused while launch recovery is unresolved. A final `completed` state for a delegated task requires the most recent job to have verified artifacts, while `cancelled` requires consistent terminal evidence. Bounded restart reconciliation and artifact promotion receipt functionality from Phase 6 are preserved.
- **7C: Credential audit and desktop operator controls.** Per-task credential issue, rotate, revoke and owner-token recovery events are stored inside the same hash-only credential record with a bounded audit history. New `task.credential.audit` is exposed via owner-scoped MCP and via T-Line's authenticated `GET /credentials/audit`. T-Line Brain Task panel displays the latest audit entries; it also shows unresolved delegation reservations and provides a confirm-to-attach control **only when exactly one persisted job matches**. No raw owner recovery token or Bridge idempotency key appears in inspection results.
- **Command parity.** `/brain task.launch.inspect <taskId>` and `/brain task.launch.recover <taskId> <jobId> CONFIRM`, together with `/scratch` aliases, appear in the canonical autocomplete catalog and generated desktop suggestions. Remote MCP launch inspection and recovery require the task owner's separate recovery credential; local CLI/T-Line operator access remains principal-scoped.
- **Release gates.** New `tests/brainLaunchRecovery.test.ts` covers missing evidence, wrong key/cwd, refusal without confirmation, and successful evidenced attachment. Existing task, MCP and desktop tests cover delegation and credential workflows. Generated backend source and the suggestion manifest are checksum-pinned by `scripts/sync-brain-runtime.ts --check`.

## Offline acceptance evidence
`bun scripts/verify-brain-release.ts --with-tline` reached `PASS: offline Brain release checks`:
- SuperAgent Brain/MCP/OAuth simulation: **64/64 passing**, across 20 suites.
- T-Line Brain backend: **16/16 passing**.
- T-Line Brain UI and command parity: **11/11 passing**.
- SuperAgent TypeScript/Bun build; T-Line backend/frontend builds; generated Brain source and commands checks; README checks: all passed.
- T-Line frontend still produces non-blocking CSS selector/minification and bundle-size warnings. Review these separately; do not claim the UI build has zero warnings.

## Live acceptance (not a production signoff)
- **MCP OAuth:** active SuperAgent Cloudflare tunnel on local port 9227. Public unauthenticated `GET /mcp` returned HTTP 401 with Bearer challenge and OAuth authorization-server metadata returned HTTP 200 on 2026-10-23. An authenticated browser consent + token exchange + read-only MCP invocation **has not** been performed. No tunnel was restarted or its token inspected.
- **Claude CLI:** `claude --version` reported 2.1.148 and `claude auth status` reported logged in. A read-only `plan` mode connection acceptance task still failed with `Self-signed certificate detected`. Neither `NODE_EXTRA_CA_CERTS` nor `SSL_CERT_FILE` was set at probe time. A trusted CA bundle must be supplied and validated by the host administrator; never bypass TLS verification.
- **T-Line desktop:** Windows Rust/MSVC/WebView2/Bun toolchain checks passed and prior NSIS bundles exist, but no running installed T-Line process was observed. The packaged GUI with Phase 7 changes was not rebuilt/installed/opened for manual Brain Explorer acceptance. No interactive desktop signoff.
- **Remote CI:** `gh run list` for `brain-core.yml` and `brain-integrity.yml` returned 404 on remote default branches. Both repositories contain many older local commits ahead of `origin/main`, and SuperAgent has unrelated uncommitted work from concurrent agents. Remote workflows cannot be validated without a coordinated publish. No blanket `git push main` or destructive restart was performed.

## Commands / verification
```text
/brain task.launch.inspect <taskId>
/brain task.launch.recover <taskId> <jobId> CONFIRM
/brain task.reconcile
/brain artifact.recover

MCP superagent_brain actions:
  task.launch.inspect     (ownerRecoveryCredential required)
  task.launch.recover     (ownerRecoveryCredential, jobId, confirm=true)
  task.credential.audit   (owner-scoped, redacted)
```

```bash
# SuperAgent repo
bun scripts/sync-brain-runtime.ts --check
bun scripts/verify-brain-release.ts --with-tline

# T-Line repo
bun scripts/check-brain-runtime.cjs
```

## Remaining operator work before deployment
1. Import and trust the appropriate organizational/proxy CA certificate chain using the supported runtime trust-store configuration, then rerun a read-only Claude CLI Bridge delegate test. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`.
2. Complete **authenticated** OAuth consent, token exchange and a read-only MCP tool call via the public SuperAgent endpoint with a dedicated test identity.
3. Build/launch the updated packaged T-Line in an isolated desktop session without killing listeners used by parallel sessions. Inspect Brain Explorer, launch recovery, credential audit and slash autocomplete visually.
4. Coordinate merge/push with simultaneous work on `main`; verify GitHub Actions on the actual published SHA.
5. Monitor retained unresolved/legacy launch reservations before any operator intervention. Never remove a `.launch.json` solely because it is old: a child process might still be active.

## Release decision
**Phase 7 code and offline gates passed; production acceptance remains NOT SIGNED OFF** until live OAuth, TLS, desktop and remote CI verification are completed. Reconciliation never launches a duplicate delegate on ambiguous evidence.
