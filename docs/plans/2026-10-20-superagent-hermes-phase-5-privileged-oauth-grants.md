# Hermes Phase 5 — Separate OAuth Privileged Project Administration

Date: 2026-10-20
Status: Increment implemented with local OAuth HTTP/SDK acceptance; overall Phase 5 and external public tunnel acceptance OPEN.
Master: docs/plans/2026-10-18-superagent-hermes-like-implementation-master-reference.md

## Confirmed gap

The MCP server correctly required mcp:tools:write for dangerous tools, even when YOLO was on. But write was also sufficient to discover/call tools that modify project registration and project access-control grants. A token with file-write access should not automatically receive authority to change the set of registered projects or expand access grants.

## Hardened contract

- A new **mcp:tools:admin** OAuth scope is explicitly consented through the owner/bootstrap PKCE OAuth flow. It is only valid alongside **mcp:tools:write**; ordinary read or write alone cannot grant project administration.
- Five project registry/ACL tools require the extra scope: superagent_register_project, superagent_update_project, superagent_remove_project, superagent_grant_project_access and superagent_revoke_project_access.
- Metadata and tools/list advertise those tools only to an OAuth token that currently carries *both* write and admin grants. Cached calls from previously authorized but now non-admin principals are denied before routing to projects.
- OAuth authorization rejects unsupported scopes instead of silently minting unsupported grants, and rejects admin-only requests that lack write. The owner-consent page explicitly warns when a client requests project administration.
- Scope denial audit records a stable insufficient_oauth_admin_scope code and omits caller-supplied arguments (commands, filenames, tokens, sensitive values).
- Existing workspace/project permission gates, disabled-tool checks, Full YOLO requirement for granting cross-workspace access, and dangerous-tool owner opt-in remain independent. OAuth admin permission is **necessary, not sufficient**, for registry/ACL mutation.
- Static bearer and local stdio modes keep existing local policy behavior; the extra OAuth scope does not silently alter their permission model.

## Verification

- Tests verify OAuth metadata, unsupported scope rejection, privileged consent warning, separate HTTP sessions for ordinary writer versus admin client, list/call restrictions, no admin escalation from Full YOLO without OAuth admin, dynamic removal of admin scope on the same MCP session, denial audit with redacted arguments, and existing static bearer multi-project behavior.
- Local approval through OAuth bootstrap is **per token/grant**, not a per-operation human confirmation. Do not claim that individual privileged calls require a separate interactive approval.

## Remaining acceptance gates

Public Cloudflare/OpenAI tunnel end-to-end consent, independent client revocation over multiple hosts, persistent grants after restart, granular tool-level approval for other high-impact operations, and Phase 5 release readiness remain unverified.

## Verified local acceptance — October 20, 2026

- TypeScript build: passed.
- Extension JavaScript verification: passed (8 files). Wiki validation: passed (9 documents, 24 links).
- Focused OAuth/admin, PKCE, project registration/grants and static-bearer multi-project suites: 57 tests passed across 6 suites.
- Full Vitest run (maxWorkers=3): **exit 1; 392 suites passed, 1 failed, 1 skipped; 3,673 tests passed, 1 failed, 5 skipped**.
- The sole full-suite failure occurred in tests/skillsInjection.test.ts (custom system prompts, Superagent/Subagent tiers). That test was rerun together with the key OAuth suites and passed; the rerun totals **62 passed across 6 suites**. The global failure remains an open acceptance gate rather than a certified full-suite pass.
- Focused and full totals overlap and must not be combined.
- No external Cloudflare/OpenAI tunnel, per-operation human approval or real remote privileged administration has been certified here.
