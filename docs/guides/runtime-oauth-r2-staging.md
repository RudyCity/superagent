# R2 — New independent OAuth issuer, staging verification (2026-10-26)

**Implemented:** pluggable OAuth store contract, separate staged OAuth CLI owner, atomic-replace snapshot persistence with HMAC integrity, issuer/client/code/access/refresh record validation, and opt-in Windows CurrentUser DPAPI encryption of the NEW issuer key. Neither legacy OAuth server nor a production tunnel is modified. This is NOT a fully certified production keystore or a credential migration.

Run only with a NEW, private directory under ~/.superagent-local-staging and an unused staging port:

    set SUPERAGENT_MCP_OAUTH_STAGING=1
    set SUPERAGENT_CORE_STAGING=1
    set SUPERAGENT_SENOPATI_AUTOSTART=0
    set SUPERAGENT_CONFIG_DIR=C:\Users\<user>\.superagent-local-staging\<fresh-dir>
    set SUPERAGENT_MCP_OAUTH_STAGE_BOOTSTRAP=<random 64-hex secret>
    bun dist/cli.js mcp oauth-stage --port <unique-unused-port>

The OAuth consent secret must not be committed or placed into a shared config. Separate issuer URL is fixed to http://127.0.0.1:<port> while staging; never route to public clients. Raw bearer/code values are not stored; SHA-256 hashes, client metadata, expiry, scope, resource and revocation state are. Snapshot integrity is HMAC keyed by a separate private file. On Windows the new staged issuer now uses oauth-state.key.dpapi with CurrentUser DPAPI and refuses automatic downgrade to the older plaintext oauth-state.key format. The independent staged key is decrypted only by the current Windows user; no key is embedded in shell arguments. The plaintext key format requires an explicit raw-test choice in isolated tests. On corrupted snapshot, missing key, changed issuer, wrong user or invalid records, startup fails closed instead of silently replacing the issuer. File creation requests mode 0600, but Windows OS account isolation/ACL, transactional durability and backup recovery are **not certified**; do not deploy this stage owner with production secrets.

This implementation uses atomic file replacement for the single local owner, fsyncs the temporary snapshot, checks the HMAC before overwriting, and takes an exclusive short-lived writer-lock to reject stale concurrent writers. A leftover writer-lock is deliberately NOT auto-deleted after a crash: it blocks further writes until operator reconciliation. This reduces lost-update and torn-write risks but does NOT provide a fully certified transactional SQL store, directory fsync durability, service-account keystore rotation, cross-machine arbitration or automatic rollback; a crash/power outage during persistence still requires operator reconciliation. No live session transport survives restart, and clients must initialize new Streamable HTTP MCP sessions; existing 6789/9877 clients must not be silently migrated.

Staging validation:

    bun run build
    bun --bun x vitest run --maxWorkers=2 tests/mcpDurableOAuthR2.test.ts tests/mcpWindowsDpapiR2.test.ts tests/mcpOAuthHttpE2E.test.ts
    bun scripts/verify-independent-oauth-stage.ts

The stage harness launches a newly isolated issuer process, tests metadata and DCR, stops only a PID verified to own the unique temporary port, and starts it again to verify client registration persisted with no redirect escalation and no changes to active production listener PIDs.

**Still required for production R2:** certified service-account DPAPI/keystore recovery and Windows ACL access probe, atomic durable transactions (prefer SQLite for token rotations), explicit migration key-backup/restore controls, external TLS ingress, OAuth consent UX and rate limits, an independent authenticated health/drain control plane for OAuth owner, external-client PKCE/refresh/revoke E2E across a real tunnel. Until these gates pass, the R7 cutover policy MUST remain blocked.

### Redirect and client identity hardening (2026-10-26)

Dynamic registration, authorization and store-side client registration now
use one parsed redirect-URI validator. HTTP callback URIs are allowed only
for the actual loopback hosts localhost, 127.0.0.1 and [::1]; a similarly
prefixed attacker hostname is refused. HTTPS callback URIs must not carry
embedded user credentials, fragments, backslashes or control characters.
Registration refuses duplicate client IDs rather than replacing an existing
client's approved callback destinations and bounds the redirect URI count.
Negative tests: tests/mcpOAuthRedirectSecurityR2.test.ts. CI runs them on
Windows and Linux. This protects client metadata but is not a public issuer
deployment certificate; client authorization and external TLS still require
review.

### Paired snapshot + DPAPI-key recovery rehearsal (R2 follow-up)

The isolated offline stage now includes
src/core/mcp/mcpOAuthStageBackupR2.ts with
backupOfflineNewOAuthStageR2 and restoreOfflineNewOAuthStageR2.
These functions are intentionally scoped to *fresh directories under*
~/.superagent-local-staging; they cannot overwrite any existing target,
operate on production ~/.superagent-r, import legacy OAuth data, or
re-key an issuer. They require the original issuer, exact key mode and
matching SHA-256 checksums. The store itself verifies the snapshot HMAC
and key; each copied file is created with wx and fsync before publishing
the new stage directory. Symbolic/multiple hard links, a writer-lock,
tampering and mixed key modes fail closed. For loopback issuers on
Windows, a live TCP listener also refuses backup.

On Windows the key material remains wrapped in CurrentUser DPAPI; a
backup made for one Windows account cannot automatically be recovered
by another. It is still a sensitive local backup: keep the entire
paired bundle inside a private stage profile, restrict OS access, and
delete test artifacts after verification. BACK UP ONLY AFTER STOPPING
THE TEST-OWNED ISSUER. A quick file checksum or absence of a lock is
not proof that a public/HTTPS issuer has drained all active writes.
Hot backup, SQL transactional guarantees, real storage snapshots,
cross-account key recovery, Windows ACL certification and production
issuer rollout are not authorized by this rehearsal.

Verification: bun --bun x vitest run tests/mcpOAuthStageBackupR2.test.ts
The suite exercises a full OAuth refresh-token restoration, DPAPI on
Windows, live-loopback exclusion, corrupt backup, existing target,
wrong issuer, writer lock and out-of-scope directories.
