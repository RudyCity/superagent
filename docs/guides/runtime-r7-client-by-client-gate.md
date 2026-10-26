# R7 — Read-only client-by-client migration decision

Implementation: src/core/runtime/runtimeClientMigrationR7.ts.
Automated negative tests: tests/runtimeClientMigrationR7.test.ts.

This is a per-client evidence validator, NOT a migration executor.
The result permits only READ_ONLY_REPORT. No path in this component copies
tokens, revives MCP sessions, changes DNS/tunnel routing, sends a Core
signal, or retries an external effect. An apparently complete client row
can at most be an operator-canary review candidate.

For each distinct client, an operator assembles evidence outside the Git
repository and supplies only a SHA-256 fingerprint (not the OAuth client
ID or secrets). Both old and new issuer URLs must be distinct public
HTTPS identities. The global live R6/R7 release decision must already
be a clean manual review candidate. Additional client-specific evidence
includes PKCE S256 exchange, validated resource audience, access/refresh
rotation, client OAuth reauthorization, candidate connectivity, zero old
sessions, zero unresolved tool effects, rollback drill and explicit
operator review.

All fields are operator-supplied attestations, not cryptographic evidence.
A caller must never fabricate optimistic values to bypass an evidence gap.
A clean report still does NOT authorize automatic cutover. A separately
approved, logged and reversible client routing change and post-change
validation are needed.

Current production status 2026-10-26: BLOCKED by the shared Core/MCP
owner and incomplete public ingress, desktop and soak certifications.
Use the read-only live audit before a client review:
bun src/cli.tsx core rollout-audit --port 7888
