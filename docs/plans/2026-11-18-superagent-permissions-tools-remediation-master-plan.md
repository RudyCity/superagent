# SuperAgent — Permissions, Tools & Tray Verification Remediation Master Plan

**Date:** 2026-11-18  
**Scope:** SuperAgent Core, MCP OAuth/gateway, MCP Connection Controls, per-project grants, host permanent-file-policy v2, Desktop UI, Tray Security Approval & Notification Center, CI, Windows installed runtime.  
**Owner intent:** Resolve the remaining functional gaps end-to-end without broadening privilege, bypassing host policy, or repeatedly asking for an already-approved grant.  
**Status:** IN PROGRESS / PARTIAL SOURCE IMPLEMENTATION. Initial OAuth/CI, permission diagnostics and JS notification fixes are committed, but native mediator, signed exact incident receipt, runtime and release acceptance gates remain OPEN. See [execution ledger](./2026-11-18-superagent-permissions-tools-execution-ledger.md) and [native threat model](../security/2026-11-18-desktop-native-mediation-threat-model.md).

## 0. Baseline, decision and constraints

### Current confirmed facts (audit baseline, not runtime acceptance)

- MCP Execute grant, project-grant access and permanent file-policy are **independent** checks; grant approval does not imply the right to inspect protected window content.
- `probe`, `find_window`, `get_active_window` and `inspect_security_prompts` (without extra parameters) were successful in an earlier live test. `inspect_window`, `open`, `snapshot` and `focus_window` remained blocked by permanent file-policy v2.
- The host file gate currently uses per-tool/action certification. `inspect_window` invokes semantic snapshot even with `includeScreenshotImage:false` and therefore **is not a metadata-only action**.
- Source patches already add non-executing `superagent_tool_describe(...,checkArguments)` for Desktop UI, bounded diagnostic outcomes, improved OAuth/project capability metadata and redacted audit logging. They are not a substitute for a native Desktop UI mediator.
- Notification Center source routing for 17 categories and some deep links exists in source; OS-native banner activation with an authenticated exact incident token and live Tray click acceptance are not yet proven.
- In the last live service observation, MCP was active while Core ownership was `OWNER_UNVERIFIED` and Tray owner was not registered as active. Do **not** infer that a responding HTTP port is a safely owned process.

### Safety and repository invariants

1. **No privilege bypass:** OAuth, explicit MCP Connection Controls Execute grant, project capability, permanent file policy, native human consent, window identity, revision/lease checks and tool allowlist remain conjunctive. A successful preflight is advice, **never** a grant.
2. **No unsafe local mutations:** preserve dirty tree and running user sessions. Never checkout/reset/clean/rebase, kill an unverified process, replace secrets, migrate production, deploy or restart without a confirmed owner-approved plan.
3. **No side effects during preflight:** no project grant creation, no approval auto-retry, no arbitrary file existence probes, no screenshot/UIA text, no shell execution, no window focus.
4. **No content leaks:** never include raw paths, protected file names, OAuth bearer values, session tokens, screenshot bytes, chat content or opaque input arguments in audit, discovery, notifications or denial messages.
5. **No false green:** report **Implemented**, **Tested**, **Runtime Verified** and **Released** separately, with commit digest, exact tests and attested running build identity.

## 1. Priority & milestones

| Milestone | Priority | Deliverable / capability | Depends on | Acceptance gate |
| --- | --- | --- | --- | --- |
| M0 — CI & regression baseline | P0 | Green focused MCP/Tray security gates, explicit failing/blocked cases and test results | None | Focused Vitest + TypeScript + Core build + Windows CI, zero regressions |
| M1 — Core/Tray owner & build attestation | P0 | Verified local owner, runtime digest parity, safe start/reload plan | M0 | Core, MCP, Tray each report distinct verified owner and deployed build; no unverified adoption |
| M2 — Permission decision engine/diagnostics | P0 | Unified reason-coded permission trace and preflight for *bounded certified actions* | M0 | No duplicate grants; current revoke reflected; no path or credential leakage; no execution |
| M3 — Native Tray-owned navigation receipts | P0 | Authenticated self-scoped notification click/tab/target verification | M1, M2 | Exact notification->tab/request receipt in active Tray, without arbitrary desktop screenshot/input |
| M4 — Native Desktop UI file-policy mediation | P0, security-critical | Small native broker with precise permitted surfaces/actions; no broad window-content exemption | M1–M3, architecture security review | Negative tests for protected content and spoofing pass; only vetted operations certified |
| M5 — Access Manager, MCP clients and notifications UX | P1 | Accurate permission states, actionable reason/remediation, read-on-open behavior and separate principal identity | M2–M3 | All supported notification sources route correctly and permission state is never misleading |
| M6 — OS banner activation & remaining exact IDs | P1 | Safe exact navigation from Windows notification and ID-bearing events; bounded fallback | M3, M5 | Banner activation routes to exact owned item; stale/tampered IDs rejected |
| M7 — Integration, rollout & release | P0 release gate | Cross-platform tests + installed Windows E2E + monitored release | M0–M6 | Signed/attested build, clean CI, actual host verification, rollback and release evidence |

**Suggested execution order:** M0 → M1 → M2 → M3 → M5 → M4 → M6 → M7. M4 may begin architecture/design in parallel but **must not** enable raw desktop content until the security gate passes.

## 2. Implementation checklist by milestone

### M0 — Establish reliable tests before further policy changes

- [ ] Reconcile latest main with working-tree edits; inspect GitHub Actions and repair existing failures without hiding test failures or disabling jobs.
- [ ] Run `bun install --frozen-lockfile`, `bun --bun x tsc --noEmit`, `bun run build` on a disposable/CI workspace preserving user edits.
- [ ] Run:
  `bun --bun x vitest run --maxWorkers=2 tests/mcpApprovalAndFilePolicy.test.ts tests/mcpFilePolicyMatrix.test.ts tests/mcpToolGateway.test.ts tests/desktop-ui-integration/registered-file-tool-gate.test.ts tests/desktopTrayNotificationsUi.test.ts tests/desktopTrayFeedback.test.ts`.
- [ ] Confirm .github/workflows/mcp-fast-regression.yml focused and cross-platform policy matrices (Windows/Linux/macOS); explicitly verify the latest commit's workflow run and job logs, not a prior green run.
- [ ] Add deterministic tests for malformed command fields, nested gateway routing, provider identity changes, stale grants, revoked host files, unavailable/corrupt grant stores, and notification item expiry.
- [ ] Produce evidence manifest with test command, platform, SHA, job link, status and residual failing cases.

**DoD:** targeted gates actually pass; failures and excluded live hardware tests documented. No production restart.

### M1 — Core/Tray ownership, runtime digest & safe lifecycle

- [ ] Trace why last live observation showed MCP active, Core `OWNER_UNVERIFIED`, Tray inactive/unmanaged; distinguish process alive, HTTP response, supervisor attestation, and installed WebView resource digest.
- [ ] Introduce/complete read-only `owner_status` telemetry: executable path/digest, PID and process birth identity, version, Core backend generation, Tray WebView bundle digest, supervisor lease and native signer/attestation.
- [ ] Ensure Tray code does not silently use stale UI assets after a source-only GitHub commit. Report `source_changed_not_loaded` rather than `ready`.
- [ ] Offer **plan** for supervised restart/reload with exact affected owner. Refuse unverified adoption/kill. Preserve active MCP connections, approvals and user sessions.
- [ ] After explicit owner-approved operation, verify post-restart ownership and source/runtime digest parity independently for Core, MCP backend and Tray.

**DoD:** exact installed bundle SHA and verified owner of each relevant process, with read-only inspection not conflated with restart authorization.

### M2 — Unified command-specific permission decisions

- [ ] Define a shared structured decision vocabulary: `ALLOWED_TO_ATTEMPT`, `SCHEMA_INVALID`, `OAUTH_SCOPE_MISSING`, `MCP_CONNECTION_EXECUTE_REQUIRED`, `PROJECT_CAPABILITY_MISSING`, `HOST_FILE_POLICY_UNCERTIFIED`, `HOST_FILE_POLICY_DENIED`, `NATIVE_CONSENT_REQUIRED`, `TARGET_IDENTITY_MISMATCH`, `HOST_OWNER_UNVERIFIED`, `TOOL_DISABLED`, `TARGET_UNAVAILABLE`, `POLICY_STORE_UNAVAILABLE`.
- [ ] Keep decisions as independent layers with `checked/not_checked/granted/blocked/unknown` rather than a single Boolean `available`; `ALLOWED_TO_ATTEMPT` must explicitly disclaim native approval and race/revocation.
- [ ] Reuse the production authorizer's pure validation where safe. **Do not create a second whitelist** that can disagree with actual dispatch. If a permission cannot be checked without side effects, report `not_checked`.
- [ ] Extend `superagent_tool_describe` preflight only to tightly bounded non-sensitive tools/actions. Avoid arbitrary file-path probes, access to opaque device content or dynamic action execution.
- [ ] Provide machine-readable remediation: grant missing? link to correct Tray section/request; host blocked? show an unambiguous reason without requesting same MCP permission again; invalid arguments? show supported schema fields.
- [ ] Unify direct tools and `superagent_tool_execute` decisions, OAuth scope aliases and project capabilities; preserve denial parity and avoid schema leaks to principals who cannot discover a dangerous tool.
- [ ] Bound audit data: hashed principal correlation, decision code and stage, opaque event ID, **never** raw payload or local file paths. Negative privacy tests required.

**DoD:** a denied request explains **which independent gate** blocked it and the safe next step; granting Execute cannot turn a host-file-policy denial into success.

### M3 — Tray-owned notification navigation test/receipt channel

- [ ] Build a **dedicated native Tray test interface**, not general `superagent_desktop_ui` bypass. Require authenticated MCP principal and a purpose-limited, operator-approved capability if any UI state is modified.
- [ ] Accept only server-issued bounded event identity (not title/body), allowlisted `page:tab` targets and a verified Tray owner/executable/WebView digest. No arbitrary window enumeration, screenshot, shell, JS evaluation, or generic click commands.
- [ ] Use short-lived, nonce-bound navigation requests and receipts with exact incident ID hash, target tab, row-found/expired status and source build SHA. No approval/deny/retry/grant action may be callable through this channel.
- [ ] Test click card, click CTA, keyboard activation, stale event, malformed/tampered nonce, cross-principal request, tab-not-loaded race, update during reload and a denied project request.
- [ ] A failed click must yield `NOT_DELIVERED` or `TARGET_EXPIRED`, never claim it navigated. Mark-as-read is a separate, explicit state transition with native ack.

**DoD:** active Tray supplies an attested, non-sensitive receipt for opening MCP Connections -> exact pending access request without accessing arbitrary desktop content.

### M4 — Security-reviewed native Desktop UI broker

- [ ] **Threat model first:** protected file shown inside arbitrary apps, browser PDFs, private chats, file dialogs, clipboard, window spoofing, PID reuse, executable replacement, UIA text, screenshot pixels, and race between discovery/consent/action.
- [ ] Define data classes and strict mediation: start with **owned SuperAgent Tray controls** and semantic allowlisted elements; treat arbitrary third-party window content under v2 as **DENY** until there is provable content/file mediation. Pixel scanning alone must not be accepted as a safety proof.
- [ ] Add verified native endpoint pinned to exact PID, birth identity, HWND, signing/digest, title/bounds/revision; per-action attended approval and short-lived lease. Input requires `mcp:tools:write`, current Connection Execute, native input grant and fresh semantic target.
- [ ] Recheck registry revocation/executable digest/target on every snapshot or input; deny if the native broker cannot prove the required scope. Keep remote/Wayland-specific guardrails.
- [ ] Separate `view` and `input` with no implicit upgrade, no unsupported keyboard/takeover, no raw coordinates or arbitrary JS/clipboard/file picker bypass.
- [ ] Expose narrow certified MCP actions only once negative tests pass (protected-file-on-screen, user-mode title spoofing, stale session, cross-principal owner, revoked grant, policy corruption, device disconnect).
- [ ] Independently review Windows UIA and screen capture boundaries, then design macOS/Linux parity without assuming Windows privileges apply there.

**DoD:** demonstrate positive controls for approved owned surfaces and negative privacy cases. General desktop reading remains **disabled** where reliable mediation is not established.

### M5 — Security Approval & Connected Clients UX

- [ ] Display each gate independently: OAuth token scopes, MCP Connection Controls, project capability, host registry, native view/input consent, current backend generation and loaded Tray revision.
- [ ] Show actual provider/app/client label separately from **verified OAuth client ID/subject**. Never use user-entered connection names or bearer token display names as authority.
- [ ] Multiple clients and separately authorized tokens using the same MCP URL should register as distinct authenticated sessions, with stable principal binding and no cross-client grant inheritance.
- [ ] Pending Access `Load` buttons, refresh and missing-request status should preserve tab/filter and exact event focus; response to click should not only open the parent menu.
- [ ] Mark ordinary notification cards and navigation CTA as **read on successful open acknowledgment** (including keyboard activation). Keep explicit `Mark unread`, Archive, Resolve/Approve/Deny independent; never auto-approve a request.
- [ ] Provide a bounded permission history view: approved/denied/revoked/pending/expired with reason codes and hashed principal; no secret material.
- [ ] Distinguish `grant pending`, `host policy blocked`, `backend not loaded`, `tool schema invalid`, and `needs native consent`; never request the same completed approval again.

**DoD:** user can see exactly **who** has each scope and **why** a tool failed; no hidden parallel sessions, no false authorization label, no read-on-click race.

### M6 — OS notifications and exact incident deep links

- [ ] Introduce server-issued, expiring activation token for Windows OS notification banners, bound to source, exact incident/request ID, recipient/owner and target build; verify at native Tray handler.
- [ ] Add stable event IDs where currently absent: Terminal Processes, Desktop Live sessions, LAN pairing, Updates, Muse transfer, relevant logs; typed schema/version, safe backward compatibility.
- [ ] Open exact source tab/item when available; fallback to module with clear `expired/unavailable` state if the target no longer exists. Do not guess IDs from title/body.
- [ ] Test no duplicates, no spurious mark-read, notification action button semantics, cold Tray startup, minimized/background Tray, reboot, multi-monitor/DPI, stale activation replay and duplicate OS click.
- [ ] Constrain native activation to navigation only: never invoke `approve`, `retry`, `grant`, `stop`, `restart` through a notification click.

**DoD:** banner, in-app Notification Center and toast navigate consistently without unauthorized effects.

### M7 — QA, staged rollout and release

- [ ] Run full `bun` test/typecheck/build, Rust `cargo check/test` for Tray, TypeScript + Rust lint/security tests, clean Windows/macOS/Linux Actions and negative permission matrix.
- [ ] Validate on **two PCs** and a physical Android/LAN client only for features under test; record which devices and transports actually passed, do not infer tests that were not run.
- [ ] Run installed Windows end-to-end with Tray active and verified owner: different MCP principals, one approved/one denied, repeated grants, revoked grants, protected file displayed, exact notification routes and OS activation.
- [ ] Verify backend/Tray release artifact digests, signed bundle, installed WebView asset digest and tag/commit parity. No silent hot patch or PID adoption.
- [ ] If live activation or performance fails, roll back **only an explicitly authorized, verified owned** service, preserve user sessions and evidence; report partial if any gate remains red.
- [ ] Publish evidence/receipt with **Implemented / Tested / Runtime Verified / Released** fields each independently marked.

**DoD:** release artifacts, CI logs, Windows runtime and independent policy negative tests all pass. No “all green” claim based solely on source commits.

## 3. Concrete delivery slices for implementation

| Slice | Work | Key files / components | Reviewable output |
| --- | --- | --- | --- |
| S1 | CI truth + live owner read-only diagnostics | `.github/workflows/mcp-fast-regression.yml`, `src/core/runtime/serviceManager.ts`, Core/Tray owner code | CI evidence + immutable owner/build report |
| S2 | Shared permission decision codes and parity tests | `src/core/mcp/superagentMcpServer.ts`, `mcpToolGateway.ts`, `mcpToolPolicy.ts`, `registeredFileToolGate.ts`, project access policy | Decision engine + no-bypass tests |
| S3 | Native Tray self-owned navigation test receipt | `apps/superagent-tray/src-tauri/src/main.rs`, `ui/notifications.js`, `ui/app.js`, `ui/access-manager.js` | Exact route receipt test |
| S4 | Provider/session inventory + Security Approval UX | MCP connected client/session registry, `ui/access-manager.js`, notification read/ack | Multi-client acceptance + UX tests |
| S5 | Native broker threat model and narrow implementation | `src/core/tools/desktopUiTools.ts`, Desktop UI adapters, native Tray policy bridge | Security review + negative tests |
| S6 | OS activation and stable incident IDs | Rust notification producer and activation handler, Notification Center | Cold-start/replay/expiry tests |
| S7 | Installed QA & release | CI, manifests, Windows binaries and deployment proof | Verified release artifact + rollback plan |

## 4. Definition of done and open questions

### Non-negotiable acceptance matrix

| Scenario | Expected |
| --- | --- |
| OAuth read-only identity tries dangerous Desktop UI | Rejected at scope/discovery; no capability/secret inference |
| Execute approved but file policy denies `inspect_window` | Denied with distinct host-policy code; no repeat MCP request |
| Certified `probe` with valid scope/grant | Metadata returned; no screenshot or window body |
| `inspect_security_prompts` receives unsupported `limit` | Schema/argument error; never masquerades as missing approval |
| Grant revoked between preflight and execute | Execute denied; no cached permission bypass |
| Corrupt policy/grant registry | Fail closed with no host path, hash or token leak |
| MCP client A/B have same server URL, distinct credentials | Sessions and grants stay isolated |
| Protected file visible in a third-party app | No screenshot/semantic body returned by unmediated route |
| Pending Access notification opened | Correct tab + exact request highlighted, native receipt, marked read only after ack |
| Expired/tampered OS notification | No action, explicit stale/unavailable message |
| Tray running old bundle after GitHub commit | Source/runtime mismatch reported, not `Runtime Verified` |
| Owner unverified | No restart/adoption/kill; diagnostic and attended recovery plan only |

### Architectural decisions requiring proof (not blanket assumptions)

1. Can owned Tray UI expose a **non-content navigation receipt** entirely inside a trusted native boundary while maintaining principal separation? If not, keep testing via attended local E2E instead.
2. For arbitrary apps, how can the host prove that pixels/UIA text do not include denied file content? **If there is no reliable proof, the correct behavior under v2 is to deny content inspection.**
3. What exact native operator action authorizes any permission escalation or owned-process restart? Approval must be explicit and scoped; MCP/agent cannot grant itself.
4. Do the active Windows Core, MCP backend, Tray and project tree have identifiable, matching source/build SHA and verified owner? Lack of evidence is a blocked release gate, not permission to adopt processes.

## 5. Tracking rule

Each implementation PR/commit should update a single ledger with:
- `id`, `priority`, `risk`, `owner`, `files`, `dependencies`, `acceptance`
- `implementedSha`, `tests`, `ciRunUrl`, `runtimeBuildSha`, `deviceEvidence`, `releaseTag`
- `status` separately for **Implemented**, **Tested**, **Runtime Verified**, **Released**
- `blockedReason` and `nextAction` when any gate is not passed.

**Completion condition:** No remaining P0 security, identity, host mediation, owner attestation or installed runtime acceptance gap; P1 items demonstrated with explicit tests, or clearly marked deferred without claiming full notification coverage.
