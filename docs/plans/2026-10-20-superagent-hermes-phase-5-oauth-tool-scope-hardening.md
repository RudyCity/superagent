# Hermes Phase 5 — MCP OAuth Scope Hardening

Date: 2026-10-20
Status: Bounded local security increment. Full Phase 5 and live OAuth staging gates remain open.
Master: docs/plans/2026-10-18-superagent-hermes-like-implementation-master-reference.md

## Confirmed vulnerability

MCP previously checked mcp:tools:write only when dangerous tools were not unlocked. Enabling YOLO or allowDangerous inadvertently let read-only OAuth clients invoke write tools. Local operator opt-in to expose a tool must not elevate the independent grant of a remote OAuth principal.

## Changes

- In OAuth mode, a dangerous tool call always requires current mcp:tools:write scope, even if allowDangerous, Scoped YOLO or Full YOLO is enabled. Missing identity or missing scope is denied before project resolution.
- Denied OAuth write payloads are withheld from audit and activity subscribers. The denial records authorizationDecision=denied, errorCode=insufficient_oauth_scope and correlation context without forwarding commands or file contents.
- OAuth tools/list dynamically reflects the current OAuth write grant. Removing mcp:tools:write hides dangerous tools from the next listing, and previously cached calls are blocked at dispatch.
- The existing tunnel allowlist, disabled tool rules, project grants and workspace restrictions remain independently enforced. Write scope alone is not execution permission.
- Static bearer operation remains governed by existing owner-selected dangerous/YOLO and workspace policy, without silently introducing OAuth semantics.

## Tests and source audit

- Read-only OAuth tokens are denied even with Full YOLO and allowDangerous; no file is written, and denial audit omits caller payload.
- OAuth write tokens are still denied when dangerous tools remain locked; authorized tokens can perform a scoped write after owner-enabled access.
- Dynamic same-server scope revocation removes dangerous tools from discovery and prevents cached dangerous calls.
- Static source audit found 40 inline MCP tool definitions and no missing security classifications. That audit does not certify every independently loaded external tool.

## Remaining gates

Live OAuth code issuance, revocation and expiry over authenticated HTTP, multi-client and project isolation, remote tunnel transport, privileged approval flows and staging tests remain open. This increment is not a complete Phase 5 permission middleware or production security certification.

## Verified local acceptance — October 20, 2026

- bun run build: passed (TypeScript).
- bun run verify:extension-js: passed (8 extension JavaScript files).
- bun run wiki:validate: passed (9 documents, 24 checked links).
- Focused OAuth/YOLO, MCP server, compatibility, HTTP transport and security tests: **82 passed across 5 suites**, zero failed.
- Full bunx vitest run --reporter=default --maxWorkers=3: **exit 0; 386 suites passed, 1 skipped; 3,643 tests passed, 5 skipped; 0 failed**.
- Static audit found 40 inline MCP tool definitions with no missing classification in the source inspection.
- Focused and full test totals overlap; do not add them together.
- Live OAuth over remote tunnel, token issuance/revocation across separate HTTP clients and staging remain open release gates.
