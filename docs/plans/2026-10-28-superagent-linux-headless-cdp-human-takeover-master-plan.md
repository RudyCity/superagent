# SuperAgent Linux CDP Headless + Secure Human Takeover — Master Implementation Plan

**Date:** 2026-10-28  
**Project:** SuperAgent (CLI/Core, MCP, browser automation)  
**Target branch:** main  
**Status:** PROPOSED / PLAN ONLY — no runtime code changed, no production certification  
**Owner:** SuperAgent Core / Browser Gateway  
**Priority:** P0 security and ownership before enabling remote takeover

## 1. Objective

Enable SuperAgent CLI on a displayless Linux host (SSH/VPS/Docker/mini PC) to drive Chrome/Chromium through CDP, pause safely when a person must handle an authentication/verification challenge (e.g. Google sign-in, OTP, passkey, CAPTCHA, consent), allow that person to control the *same browser instance/profile* through an authenticated remote session from a phone/laptop, and resume the original agent only after explicit release and successful verification.

This is an extension of the existing CDP coordinator, managed browser registry, and human/agent handoff. Do not build a second uncoordinated CDP control plane.

**Non-goals:** automated CAPTCHA bypass, extracting passwords or MFA secrets, sharing authenticated cookie jars among unrelated users, exposing CDP/VNC ports to the internet, promising all sites will permit automated sign-in, fully automatic conversion of a running true-headless Chrome process into a GUI without restart.

## 2. Verified baseline from current source (2026-10-28)

- `src/core/tools/chromeCdpTools.ts` connects to Chrome over local CDP HTTP/WebSocket and supports DOM, navigation, screenshot, PDF, emulation and multi-agent operations. It does not inherently require a visible OS window.
- `src/core/tools/chromeCommon.ts` implements `ensureCdpRunning`: Windows/macOS/Linux executable selection and isolated debug profile, but does **not** add Linux `--headless`, auto-detect unavailable displays, or supervise a virtual desktop.
- `src/core/tools/chromeBrowserTools.ts` `launchChromeProfileTool` launches `google-chrome` on Linux without a headless flag or a structured browser lifecycle contract.
- `src/core/tools/chromeProfileTools.ts` already handles Linux Chrome profile discovery.
- `src/core/tools/chromeCdpSessionManager.ts`: cross-process per-target claim, lease, lock, generation and write serialization.
- `src/core/tools/managedBrowserRegistry.ts`: runtime fingerprint/registration; current design targets local authenticated managed browser registration.
- `src/core/tools/managedBrowserControl.ts`: validated human/agent hold; agent writes blocked during human control, bound to current browser identity.
- `src/core/tools/crossIdeCdpGateway.ts`: authenticated MCP-session-specific CDP gateway; legacy direct CDP connections remain a risk if the debug port is externally accessible.
- Existing reference: `docs/plans/2026-10-26-managed-browser-human-agent-handoff.md`. Its own documented gap is real packaged UI / concurrent-agent E2E certification.
- Existing tests: `tests/managedBrowserControl.test.ts`, `tests/managedBrowserRegistry.test.ts`, `tests/chromeBrowserTools.test.ts`, `tests/chromeCdpMultiAgent.test.ts`, `tests/crossIdeCdpGateway.test.ts`.

**Important:** These are code inspection findings, not evidence that Linux headless, virtual desktop, remote takeover, or Google login have passed a live E2E. The working tree is dirty with parallel changes; do not reset, restore, stage or commit unrelated files.

## 3. Architecture decision

Use three explicit browser runtime modes plus AUTO:

| Mode | Linux mechanism | Primary use | Human remote UI |
| --- | --- | --- | --- |
| `headless` | Chrome/Chromium `--headless` with CDP | unattended DOM and screenshots | not directly through VNC |
| `virtual-display` | Xvfb + minimal WM + headed Chrome + CDP | authenticated browser workflows / HITL | **yes**, over authenticated noVNC gateway |
| `headed` | visible local desktop Chrome + CDP | Windows/macOS/Linux workstation | local or platform-managed UI |
| `auto` | policy-based selection, explicit overrides | everyday use | choose virtual-display at launch when human interaction is possible |

Do **not** assume presence of `DISPLAY` means a working X server. Probe availability. On displayless Linux, AUTO may select headless for unattended jobs and **virtual-display at startup** for login-capable jobs. Do not silently kill/restart a live authenticated browser to switch modes.

### Proposed data flow

```text
SuperAgent CLI / Agent / MCP
  -> Browser Runtime Manager (owner, process lifecycle, health)
  -> Canonical CDP Gateway / Session Coordinator (claims, locks, revisions)
  -> Chrome instance (per-account isolated user-data-dir, loopback CDP)
          |-- Linux headless: no display
          +-- Linux virtual-display: Xvfb + minimal WM
                      -> local VNC/noVNC transport
                      -> authenticated, short-lived HTTPS takeover gateway
                      -> human on phone/laptop
```

**Security boundary:** the remote user connects only to an authenticated takeover service, never directly to a Chrome CDP endpoint or raw VNC port. CDP binds to loopback within a dedicated non-root worker/container namespace. For strong isolation, use one OS user/container per trust domain; ordinary users sharing the same Linux user can otherwise bypass app-level CDP locks by connecting to localhost.

## 4. Functional requirements

- Run on Ubuntu/Debian server without a physical monitor, desktop session, or Chrome extension.
- Probe executable candidates (`google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`) and report specific missing dependencies.
- Expose `browser runtime start|stop|status|health` via existing SuperAgent CLI/tool policy; choose profile, mode, port, viewport and persistence explicitly.
- Use a durable process ownership registry: PID plus process-start identity, executable, mode, instance ID, profile key, display number, CDP port and creation time; no blind `pkill`/kill of foreign processes.
- Reconcile dead child processes and clean up only owned Xvfb/WM/VNC/Chrome processes; no orphans, port collision hijack or infinite restart loops.
- Keep profile data persistent only when configured, private permissions (0700), and never copy cookies or tokens into the agent transcript.
- Trigger `human_required` when agent explicitly requests help or bounded challenge detection suggests sign-in, OTP, CAPTCHA or permission dialog; classify heuristics as uncertain and require operator confirmation when needed.
- Freeze **all agent mutations** on the target before the human gets control; still permit safe, authorized status reads.
- Transfer control to an authorized human through a short-lived, single-use session; show target website, task reason, host/browser profile label and expiry.
- Human input goes to the existing Chrome instance in the virtual desktop. No duplicated browser, tab, cookies or session.
- User selects `Return to Agent`; recheck identity, tab, task context, login state and fresh DOM snapshot; stale selections and queued writes cannot execute from before the handoff.
- Explicit timeout/cancel/disconnect handling; if takeover expires or is lost, remain paused/fail-closed unless operator intentionally resumes.
- Browser worker restart never auto-resumes sensitive tasks and must invalidate old generation/target claims.

## 5. Human takeover state machine

```text
AGENT_ACTIVE
  -> HUMAN_REQUESTED -> HUMAN_READY -> HUMAN_ACTIVE
  -> RETURN_REQUESTED -> VERIFYING -> AGENT_ACTIVE
                          \-> PAUSED_NEEDS_REVIEW
Any state -> CANCELLED / EXPIRED / FAILED (fail closed)
```

Rules:
1. Acquire existing CDP per-target coordinator/lifecycle lock; atomically set human hold bound to browser fingerprint + generation + target ID + revision, then notify.
2. Reject any concurrent agent CDP writes, vision clicks, extension bridge writes and MCP gateway mutations while held. Audit any legacy/tool bypass and add a guarded boundary where missing.
3. Do not give a takeover URL before the hold is installed. The human's desktop input must be exclusive while active.
4. Use an independent takeover-authorization TTL (e.g. 5 minutes to start) and bounded session lifetime (e.g. 15 minutes with explicit extensions). Expiry revokes remote input; it does **not** silently lift the agent hold.
5. On return, revoke the human remote-input capability before releasing the hold. Verify the same browser process identity and live target, produce a new snapshot/revision, clear obsolete queued actions and only then re-enable agent actions.
6. If Chrome/tab restarted during takeover, require explicit recovery and fresh registration/claim; no fuzzy URL-based auto-rebinding for sensitive sessions.
7. If CLI/MCP restarts mid-handoff, recover persisted metadata without storing credential tokens; require authorized human confirmation to recover control state.

## 6. Security and privacy (hard release gates)

- No public `:9222`, raw VNC or noVNC websocket; localhost or container-private only. HTTPS reverse proxy/tunnel with a real authenticated access layer, short-lived authorization and origin checking.
- Use OIDC/SSO or existing authenticated SuperAgent management identity; optional step-up authentication for login takeovers. A link alone must not grant unreviewed access: bind a one-time nonce to an authenticated actor + exact instance + target.
- Rate-limit session creation, enforce CSRF and WebSocket origin checks, prevent session fixation/replay and scope permissions to a single browser/display.
- Enforce explicit authorization to create/revoke takeover sessions; MCP dangerous-tool and OAuth write scope policy continues to apply. Do not let arbitrary agent messages authorize a new remote desktop.
- Redact URL query strings, password fields, OTPs, cookies, auth headers, screenshots and form contents from metadata logs and notifications. Default **no** recordings/screenshots during a sensitive human session.
- Never ask the agent to read, copy, store or relay passwords/MFA tokens. Human enters credentials in browser locally; security key/passkey flows may need platform-specific support and may be unsupported on remote Linux.
- Disable clipboard/file transfer and other desktop capabilities by default; avoid unrestricted access to host desktop, shell, local filesystem or another browser profile.
- Use dedicated non-root browser runtime, Chrome sandbox intact; do not default to `--no-sandbox`. Containers require a properly configured sandbox/user namespace and dependency checks.
- Human consent for notifications/screen access; metadata-only, per-event audit: owner, target-hash, mode, timestamps, reason class, decision, outcome. Audit denial/revocation and keep bounded retention.
- Test a direct-CDP bypass attempt from an untrusted process and document the OS isolation assumptions; in-process coordinator locks alone cannot stop raw localhost connections.
- Prompt injection defense: page text, login banners and take-over notes are untrusted data, not developer/system instructions. Critical actions after return still require normal permissions.

## 7. Proposed modules / integration points

| Area | Proposed change |
| --- | --- |
| `src/core/tools/chromeCommon.ts` | Replace basic Linux auto-launch with shared policy-aware launcher call; preserve existing Windows/macOS behavior |
| `src/core/tools/chromeBrowserTools.ts` | Add mode/profile/viewport fields and health verification; preserve safe existing API |
| New `src/core/browserRuntime/` | BrowserRuntimeManager, Linux provider, display supervisor, process identity, health, profile registry |
| `src/core/tools/chromeCdpSessionManager.ts` | Ensure human holds fence all agent writes, increment revision on handoff, cancel stale queued writes |
| `src/core/tools/managedBrowserControl.ts` | Extend authenticated managed target handoff to Linux worker registration, not only T-Line |
| `src/core/tools/managedBrowserRegistry.ts` | Register worker instance/display identity; bind generations and fingerprint |
| `src/core/tools/crossIdeCdpGateway.ts` | Refuse mutation during hold and expose authorized safe status; no raw capability leakage |
| New `src/core/browserTakeover/` | Session/state machine, invitation exchange, auth, expiry, audit, takeover/revoke/return |
| `src/serverRoutes.ts` / management API | Authenticated create/status/return/revoke endpoints plus validated noVNC websocket proxy |
| CLI / T-Line optional UI | Show `human_required`, approval link and progress; T-Line is not required for Linux CLI |
| `docs/guides/` | Install, systemd/Docker hardening, security runbook, human takeover from phone |

Avoid modifying unrelated Google Workspace reader, CLI bridge, runtime supervisor and dirty worktree changes. Coordinate with ongoing process supervisor work before editing shared lifecycle files.

## 8. Incremental milestones and task checklist

### M0 — Requirements and protected baseline (P0)
- [ ] Audit active CDP write paths (direct CDP, cross-IDE, vision, extension, terminal/cursor, managed browser); enumerate every bypass surface.
- [ ] Confirm Linux test matrix and Chrome versions, non-root sandbox, container/host deployment variant.
- [ ] Freeze API/state-machine contract and define browser-generation fencing.
- [ ] Create focused branch/worktree from known commit without staging unrelated changes.
**Gate:** threat model, ownership diagram and compatibility plan reviewed.

### M1 — Linux CDP launcher + runtime ownership (P0)
- [ ] Implement explicit modes `headless`, `virtual-display`, `headed`, `auto`; Linux executable probes.
- [ ] Implement one canonical launcher used by explicit tool and `ensureCdpRunning`; configurable profile/port/user data dir, never launch GUI on absent display.
- [ ] Add owned-process registry, single-instance startup lock, PID-start verification, health/restart budget, graceful shutdown.
- [ ] Add CDP health checks (`/json/version`, websocket, target discovery, screenshot).
- [ ] Protect Windows headed launch from regressions and avoid new Windows console windows.
**Gate:** non-GUI Ubuntu and Docker headless smoke; restart does not kill unrelated Chrome.

### M2 — Virtual desktop worker (P0/P1)
- [ ] Spawn Xvfb at per-runtime display with controlled geometry; start minimal WM and **headed** Chrome with CDP on same display.
- [ ] Create local-only VNC/noVNC-compatible access transport; start behind authenticated gateway, not public listening port.
- [ ] Prove real GUI interaction from laptop/mobile on the *same* Chrome profile and target without login duplication.
- [ ] Kill/restart owned display subprocess tree safely and preserve intended profile only.
**Gate:** real visual takeover smoke from another device, no open VNC/CDP network exposure.

### M3 — Secure human takeover protocol (P0)
- [ ] Implement authenticated create/approve/observe/control/return/cancel API with target-bound identity and one-time nonce.
- [ ] Integrate canonical managed-browser human hold with every CDP write path and queue.
- [ ] Implement authoritative states, permission checks, audit and expiry fail-closed semantics.
- [ ] Add mobile-friendly takeover landing page (site/profile/reason, Start, Return to Agent, Cancel, expiry).
- [ ] Add secure notification transport via already-approved channels (e.g. Muse/Telegram); never place browser secrets in notifications.
**Gate:** concurrent agent cannot alter or steal a human-held tab; replay, anonymous and cross-profile access denied.

### M4 — Pause/detect/resume orchestration (P1)
- [ ] Offer explicit `request_human` action for any uncertain login/OTP/CAPTCHA; optional bounded DOM signals with no content exfiltration.
- [ ] Persist paused task checkpoint (without credentials), preserve original agent goal, workspace and last target revision.
- [ ] Revoke input first on return, revalidate identity and challenge/login outcome, refresh DOM snapshot, then resume only the original authorized job.
- [ ] Handle denied/expired/multiple-human/disconnected/agent-restart/browser-restart cases predictably.
**Gate:** deterministic mock login challenge E2E resumes only after explicit successful return.

### M5 — Hardening, docs, deployment (P1)
- [ ] Add systemd non-root example and Docker Compose example with sandbox, loopback bindings, memory/CPU caps, health checks and safe storage.
- [ ] Add secret-safe config and operational commands for status, stop, revoke sessions, inspect metadata audit and incident recovery.
- [ ] Document Google OAuth/API integration as the preferred choice for Gmail/Drive automation; visual login is a fallback and may still be blocked by Google policy.
- [ ] Write clean installation and mobile takeover user guide.
**Gate:** repeatable clean-host installation and operational recovery without direct public debugging access.

### M6 — Integration and production-readiness evidence (P0)
- [ ] Unit: mode selector, executable detection, no-display, process registry, auth/CSRF/nonce expiry, hold transitions and stale revision fencing.
- [ ] Integration: mocked CDP target with two agents + human; hold before link; unauthorized mutation blocked; revoke before release.
- [ ] Linux E2E: clean Ubuntu VM with no GUI, headless DOM/screenshot, virtual-display browser, noVNC takeover from remote device, return and resumed agent action.
- [ ] Failure injection: disconnect, expired invite, killed Xvfb/Chrome, stale PID, reused port, browser new generation, restart between hold and release.
- [ ] Security negative tests: exposed port scan, unauthenticated takeover, token replay, WebSocket origin, cross-profile/session, raw CDP from another namespace.
- [ ] Regression: `bun run build`; focused Chrome/CDP/gateway tests; process supervisor integration; Windows/macOS smoke where supported.
- [ ] Sensitive-login acceptance: first use a synthetic OTP page. Optional real Google login must be manual, authorized, non-production/test-account only, without logging credentials or bypassing challenges.
**Gate:** evidence table with commands, results, artifact hashes, host/version and independent reviewer signoff; do not mark CERTIFIED from unit tests alone.

## 9. Minimum acceptance scenarios

| Scenario | Required result |
| --- | --- |
| Ubuntu via SSH, no DISPLAY | Headless CDP starts and screenshot/DOM work |
| Interactive Linux workflow | Xvfb Chrome and CDP see the exact same live tab |
| Login challenge appears | Agent pauses and safely requests human action |
| Phone opens link | Only authenticated invited actor sees scoped browser |
| Human entering OTP | All agent writes blocked; no OTP stored or relayed |
| Return to Agent | Remote control revoked, fresh snapshot and revision; agent resumes |
| Two agents same target | Queue/ownership respects human hold |
| Human disconnects | Browser remains paused; no silent agent resumption |
| Browser crashes mid-hold | New generation requires reauthorization; no stale takeover |
| External scans | No unprotected CDP/VNC endpoint accessible |
| Existing desktop setup | Windows headed CDP regression passes |

## 10. Rollout and rollback

- Feature flags default OFF: `browserRuntime.linuxEnabled`, `browserRuntime.mode`, `humanTakeover.enabled`, `humanTakeover.remoteAccessEnabled` (final names follow existing config conventions).
- Stage 1: Linux headless, local-only (M1).
- Stage 2: virtual desktop + local authenticated takeover in staging (M2–M3).
- Stage 3: guarded remote human takeover with one operator, allowlisted workflow and audit (M4–M5).
- Stage 4: broader release **only** after M6 security and E2E evidence.
- Rollback disables remote session issuance first, revokes active remote-control permissions, leaves agent holds in a safe paused state, then stops owned display/browser processes only if explicitly requested. Never erase authenticated profiles as a rollback side effect.

## 11. Risks and explicit design choices

1. **True headless cannot simply be shown through VNC:** plan virtual-display at browser launch for workflows that may need takeover; restart/switch may invalidate CDP identities. No guarantee of seamless conversion in place.
2. **Google authentication:** OAuth is preferred for Gmail/Drive APIs; UI login may reject remote browser automation or require device-bound passkeys. Manual takeover does not bypass provider restrictions.
3. **Localhost is not a security boundary against same-user processes:** OS-user/container isolation and gateway-only routing are mandatory for multi-tenant or untrusted deployments.
4. **Browser/profile singleton:** one browser instance owns one live profile. No concurrent headless/headed launch on the same `user-data-dir`.
5. **GUI resource cost:** virtual-display mode consumes additional RAM/CPU; use lazy startup and idle reaping, with no aggressive cleanup during holds.
6. **Existing runtime supervisor changes in progress:** reuse process ownership contract and avoid conflicting changes to supervisor, global config or MCP server.

## 12. Execution order and handoff contract

**Recommended order:** M0 -> M1 -> M2 -> M3 -> M4 -> M5 -> M6. Security invariants of M3 may be scaffolded in parallel with M2, but **no remote user-access rollout** before both are proven together.

For AGY delegation, require each milestone to return:
- touched-file list (scope only), commit/worktree identity, implementation diff summary;
- build/test commands with real exit codes; Linux runtime and network verification evidence;
- negative security tests and known gaps;
- precise checkpoint and next milestone;
- no broad reset/restore, unrelated staging, or claims of production certification without live Linux E2E.

**Plan creation outcome:** this document specifies future work. It is not evidence of an implemented Linux takeover service.
