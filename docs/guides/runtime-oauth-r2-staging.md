# R2 — New independent OAuth issuer, staging verification (2026-10-26)

**Implemented:** pluggable OAuth store contract, separate staged OAuth CLI owner, atomic-replace snapshot persistence with HMAC integrity, and issuer/client/code/access/refresh record validation. Neither legacy OAuth server nor a production tunnel is modified. This is NOT a production-safe OS-keystore design or a credential migration.

Run only with a NEW, private directory under ~/.superagent-local-staging and an unused staging port:

    set SUPERAGENT_MCP_OAUTH_STAGING=1
    set SUPERAGENT_CORE_STAGING=1
    set SUPERAGENT_SENOPATI_AUTOSTART=0
    set SUPERAGENT_CONFIG_DIR=C:\Users\<user>\.superagent-local-staging\<fresh-dir>
    set SUPERAGENT_MCP_OAUTH_STAGE_BOOTSTRAP=<random 64-hex secret>
    bun dist/cli.js mcp oauth-stage --port <unique-unused-port>

The OAuth consent secret must not be committed or placed into a shared config. Separate issuer URL is fixed to http://127.0.0.1:<port> while staging; never route to public clients. Raw bearer/code values are not stored; SHA-256 hashes, client metadata, expiry, scope, resource and revocation state are. Snapshot integrity is HMAC keyed by a separate private file. On corrupted snapshot, missing key, changed issuer or invalid records, startup fails closed instead of silently replacing the issuer. File creation requests mode 0600, but Windows ACL/DPAPI and disk durability are **not certified**; do not deploy this stage owner with production secrets.

This implementation uses atomic file replacement for the single local owner and tests restart/rotation/revocation. It does NOT use fsync/transactional SQL, trusted OS-keystore credentials, multi-writer arbitration or automatic rollback; a crash/power outage during persistence requires operator reconciliation. No live session transport survives restart, and clients must initialize new Streamable HTTP MCP sessions; existing 6789/9877 clients must not be silently migrated.

Staging validation:

    bun run build
    bun --bun x vitest run --maxWorkers=2 tests/mcpDurableOAuthR2.test.ts tests/mcpOAuthHttpE2E.test.ts
    bun scripts/verify-independent-oauth-stage.ts

The stage harness launches a newly isolated issuer process, tests metadata and DCR, stops only a PID verified to own the unique temporary port, and starts it again to verify client registration persisted with no redirect escalation and no changes to active production listener PIDs.

**Still required for production R2:** Windows DPAPI/keystore + ACL access probe, atomic durable transactions (prefer SQLite for token rotations), explicit migration key-backup/restore controls, external TLS ingress, OAuth consent UX and rate limits, an independent authenticated health/drain control plane for OAuth owner, external-client PKCE/refresh/revoke E2E across a real tunnel. Until these gates pass, the R7 cutover policy MUST remain blocked.
