# SuperAgent LAN Client — Local-Network Remote Terminal and Pairing Plan

**Date:** 2026-11-05  
**Status:** Initial portable Windows MVP implemented and tested on one physical LAN adapter; production milestones incomplete  
**Scope:** Windows 10/11 client, existing SuperAgent desktop/tray, agent and MCP remote-project routing.

## Intent

Make it possible to support another Windows laptop on **the same local network** without installing the full SuperAgent runtime on that laptop. The owner runs an explicitly visible lightweight `superagent-lan-client.exe`, opens pairing, sees a short-lived code, and approves a named SuperAgent controller. The controller can then open a terminal with the remote *logged-in user's* OS privileges only while a session is approved. No Internet relay, Cloudflare tunnel, public port, unattended hidden session, or implicit privilege elevation.

## Architectural fit

- **Client:** new `apps/superagent-lan-client/`, independent Windows Rust native service + lightweight consent/tray UI. A signed installer can later be built using the existing Tauri/release workflow; package a portable executable when feasible. Do not require Bun/Node, a provider API key, or a full SuperAgent Core install on target.
- **Controller:** new `src/core/lanRemote/` transport, discovery, pairing and session manager, integrated with existing MCP project-access grants and tools (do not create a second permission registry).
- **MCP tools:** add `superagent_lan_discover`, `superagent_lan_pair`, `superagent_lan_list_devices`, `superagent_lan_session_open`, `superagent_lan_terminal_exec`, `superagent_lan_terminal_stream`, `superagent_lan_session_close`, and `superagent_lan_revoke_device`. Terminal/exec are dangerous and demand existing MCP/YOLO/project `execute` authorization plus live remote consent.
- **Existing projects:** extend the registered project target representation to support a dedicated `lan` transport, without changing `local` and `ssh` behavior. Reuse command/output scoping, auditing, connection-state UI, and existing project permissions.
- **Tray:** controller panel under Runtime Detection → LAN Devices showing discovered, paired, approved, connected, expired and revoked states. Keep T-Line as the primary desktop UI; do not introduce a second general-purpose desktop app.

## Proposed operator flow

1. Both laptops connect to the same LAN (e.g., home or office Wi-Fi). On target, user launches the client **manually**, chooses **Allow LAN support**, and sees a network adapter/IPv4 address and a prominent **Stop sharing** control.
2. Controller discovers devices via mDNS or bounded UDP broadcast on selected on-link interfaces, or enters an IPv4 LAN address manually if discovery is blocked. Discovery exposes only a short display name, client version, and a short-lived device identifier; never shell/API credentials.
3. Target selects **Pair device**. Display a one-time 8-digit code, expiration clock (2 minutes), controller identity/fingerprint and cancel action. Controller enters code; limit attempts to 5 per pairing window with rate limiting and lockout.
4. Use a vetted password-authenticated key exchange (PAKE) to bind the entered code to a fresh encrypted handshake, then display and confirm matching short authentication strings/device fingerprints on **both** screens. On success, exchange and pin persistent device public keys in OS-protected per-user storage. Never send/store plaintext pairing PIN.
5. A later connection from a paired controller still requires **Approve session** locally on the client with named controller, requested capabilities and a finite expiry. No remote consent automation. Default one controller session at a time, 10-minute idle timeout, 60-minute absolute timeout (both configurable downward by operator).
6. Approved `terminal.exec` opens Windows PowerShell or cmd through native process APIs/ConPTY for interactive use, runs as the currently logged-in Windows user, and streams bounded stdout/stderr, exit code and cancellation. Any administrative action requires ordinary **target-side UAC approval**; never bypass elevation.
7. Target can **Stop sharing** or revoke a paired controller instantly; closes the session, cancels child processes (managed job object), invalidates session credentials and updates controller health. On exit/restart, sharing is OFF until deliberately re-enabled.

## LAN-only boundary (enforced in layers)

- Listen only on the selected physical/private-profile LAN interface and a dedicated configurable port, not wildcard/public interfaces or loopback-forwarded tunnel endpoints.
- Enforce local on-link source-address verification **and** route/interface validation on every accepted connection. Reject WAN, forwarded connections, cellular/VPN/virtual adapters by default, and IPv6 unless equivalent interface and firewall restrictions are implemented.
- On Windows, install/offer a narrowly scoped Defender Firewall inbound rule: Private profile only; RemoteAddress=LocalSubnet; selected program and port. Disable/remove the rule when sharing is off or the app is uninstalled. Do not create router port forwards or UPnP mappings.
- Use TLS 1.3 with pinned peer identity after pairing and mutual authentication for every command session. Recheck IP/interface, paired device, expiry, local consent and scoped capabilities on **each** new session and command.
- No cloud discovery, NAT traversal, Internet relay, public HTTP endpoint, browser-based token or reuse of MCP/Cloudflare tunnel bearer secrets. Fail closed when the physical adapter or route changes.
- Note: local-subnet firewall filters alone cannot prove that a peer is physically nearby (e.g., complex bridged networks). Explicit app-level interface checks plus firewall rules are both required; network administrators still control routing.

## Authorization and safety

- Target user must visibly launch or explicitly enable support. A paired key is **not** perpetual terminal permission.
- For commands that write files, install software, modify settings or open persistent processes, disclose requested permission in target session approval; apply existing SuperAgent permission/YOLO hard ceilings. Do not use AI instructions as approval.
- Do not run as SYSTEM, automatically install a Windows service, set RunAtStartup, run covertly, grant admin rights, disable Defender or modify UAC.
- Target-side persistent audit trail: controller identity, IP, start/end and sanitized command/exit summaries; avoid recording passwords/secret environment variables. Allow owner to export and clear logs.
- Protocol bounds: message size, output chunks, command duration, concurrent command limit, heartbeat, cancel ACK, replay nonce, version negotiation, and rate limits; treat received JSON, terminal output and device names as untrusted.
- Pairing and permission failures remain explicit failures, never fall back to unauthenticated SSH or an existing public tunnel.

## Build sequence

### Phase A — Core and native client
- Rust native Windows process and ConPTY command support, bounded IO, cancellation and process-group cleanup.
- Network selection, on-link verification, firewall lifecycle and secure local listening.
- PAKE pairing, key pinning, mTLS sessions, rate limits, expiry and revocation.
- Minimal visible consent UI plus tray state and emergency disconnect.

### Phase B — SuperAgent integration
- Local device discovery and secure session manager.
- Registry `lan` target, capability grants and MCP dangerous-tool gates; include CLI commands and tool discovery descriptions.
- Reuse existing project-aware shell execution and audit path, without weakening project-root or per-identity permissions.
- Tray panel and useful connection/expiry errors.

### Phase C — Distribution
- Produce signed x64 (and optionally arm64) Windows app executable, installer, uninstall cleanup and reproducible CI release artifacts.
- Verify Windows Defender and code-signing behavior; never claim an unsigned debug build is production ready.
- Provide instructions for private LAN/firewall, pairing, approval, revocation and troubleshooting guest Wi-Fi client isolation.

## Required acceptance evidence

1. Two Windows laptops sharing one physical LAN can discover, PAKE-pair, mutually confirm identities, approve and stream one shell command successfully.
2. Unpaired, wrong PIN, expired PIN, impersonated public key, replay, revoked key, inactive consent, wrong YOLO/MCP privilege, and concurrent session are rejected.
3. Attempts from a different routed subnet, VPN, Internet/public interface, and port-forward/tunnel are denied by app + firewall; no public listeners remain after stop.
4. Non-admin process cannot silently elevate; target UAC remains required; child processes close on disconnect and Stop sharing.
5. Pairing/session logs contain no PIN, private keys or secret command payload. Secrets are stored using Windows DPAPI/Credential Manager with restrictive ACLs.
6. Focused unit/integration tests, TS build, Rust tests, installed Windows exe smoke, second-device LAN end-to-end, denied-network test, and uninstall cleanup all pass.
7. No unrelated modified/untracked files are overwritten or staged. No new worktree is created without explicit request.

## Deliberate non-goals (initial release)

Internet remote access; unattended access; desktop/screen sharing; persistent services; file transfer; camera/microphone; silent administrative operations; bypassing guest-Wi-Fi isolation. These require separate permissions and additional threat review.

## Decision

Implement an explicitly visible LAN support client with two-sided pairing and **session-by-session consent**. Use the existing SuperAgent project and MCP authorization architecture for execution. A short PIN by itself is not adequate authentication; PAKE, key pinning, and local approval are release blockers.

## Implementation checkpoint — 2026-11-05

**Implemented and verified on local Windows:** portable Bun-compiled native EXE with an always-visible terminal and non-elevated token check; physical IPv4 adapter enumeration and on-link filtering; ephemeral TLS 1.3 certificate fingerprint pinning, 8-digit 120s pairing code with rotation and 5-attempt limit; explicit physical pairing and session approvals; process-memory pair/session tokens; 10-minute idle / 60-minute absolute session limits; bounded noninteractive PowerShell execution with cancellation and close/revoke; UDP discovery (default port); native SuperAgent tool and seven MCP tool registrations with Full YOLO gate. Sources: `src/core/lanRemote/`, `src/lanClient.ts`, `src/core/tools/lanSupportTool.ts`, `src/core/mcp/tools/lanMcpTools.ts`, `scripts/build-lan-client.ts`.

**Evidence:** TypeScript no-emit check PASS; `tests/lanRemote.test.ts` 4/4 PASS; native Windows executable built with a verified MZ header; `scripts/verify-lan-exe.ts` PASS on a real physical Ethernet adapter through pairing, target approval x2, PowerShell execution, close and revoke.

**Open release gates:** The prototype deliberately uses TLS fingerprint confirmation + one-time PIN rather than a vetted PAKE protocol. Long-lived device identity with DPAPI and mutual TLS, robust Windows Job Object isolation, persistent sanitized audit trail, automatic firewall cleanup, graphical Tray UI, interactive ConPTY, installer/signing, cross-machine LAN/WAN rejection tests, and code security review are **not implemented**. The current feature is a locally verified *prototype*, not a signed, audited production remote-support tool.

## Tray management checkpoint — 2026-11-05

- **Implemented:** SuperAgent Tray sidebar, right-click tray action, startup page selection, network scan, manual-IP/fingerprint-verified pairing, approved session management, PowerShell output, disconnect and revoke controls.
- **Integration:** Fixed Tauri `lan_support_action` calls the selected authenticated loopback Core at `/api/desktop/lan-support`; Core owns memory-only session secrets; Full YOLO is required for pairing/open/execute; emergency close/revoke remain available when YOLO is OFF.
- **Verification:** `bun run build` PASS; 23 focused Vitest tests PASS; 29 Rust tests PASS; release Windows Tray EXE compiled; static browser layout smoke PASS at widths 1280/850/760; preview package verified at `artifacts/lan-tray-preview/superagent-lan-tray-preview-windows-x64.zip`.
- **Undeployed:** Existing running Tray/Core owners were not replaced. No commit or push.
- **Remaining:** Two physical laptops E2E, signed production installer, PAKE, persistent mTLS identity/DPAPI, robust job objects, cross-process pairing with independently supervised MCP, final security audit.

## Android target checkpoint — 2026-11-05

Added a native, explicitly opt-in Android 10+ diagnostic client at
`apps/superagent-lan-android` (Java 17/AGP 9.3.1/Gradle 9.6.1). It uses
Android Keystore for per-install TLS identity, manual certificate fingerprint
confirmation, on-link Wi-Fi/Ethernet, 8-digit one-time pair code, visible
two-stage approvals, and session expiry. It has no background service,
ADB/root, unrestricted shell or Android settings control. The controller
and Tray now recognize Android platform metadata and expose safe presets.

Evidence: Android `assembleDebug` and `lintDebug` successful; Java network
scope checks 22 pass; TypeScript contract and Tray behavior checks pass.
No phone or emulator was connected for live acceptance tests. A debug-signed
APK will be packaged under `artifacts/lan-client`. The existing deployed
Core/Tray were not restarted, no worktree was made, no commit or push.

## Expanded Android support controls

Added read-only memory, network detail, power, Wi-Fi, audio, display, uptime,
app-self and sensor-type diagnostics. Added an exact allowlist of eight
owner-approved Settings handoffs and two owner-approved, one-step media volume
changes. Each action needs separate physical Android consent beyond pairing
and session approval. Opening Settings closes all sharing and invalidates
pairing. Emergency close/revoke is available during pending action approvals.
No Android shell, root, APK installation, broad permissions or unattended
behavior. Validate on a real Android phone before production claims.

## Android v0.3.0 interactive remote screen checkpoint

Implemented explicit Android MediaProjection capture consent (one new user
grant per session), private-network JPEG screen frames through the existing
TLS fingerprint-pinned LAN channel, and opt-in Android Accessibility gestures
and text input. The user must explicitly enable Accessibility in Android
Settings, approve a remote session, approve system screen capture, and then
enable touch for that session. All three authorization gates fail closed.

The Tray adds a live screen viewer with tap/swipe (normalized coordinates),
Back/Home/Recents, focused non-password text entry and end-session controls.
The Core/Tauri bridge validates exact per-action schemas and bounds JPEG
frames and coordinates. No root, ADB, lock screen bypass, silent settings,
secret extraction, saved screenshot or unattended screen capture.

Capture runs as an Android foreground service with a clearly visible STOP
SHARING notification while the user navigates other apps. Revoking capture
or support permission invalidates input privileges and stops LAN service.

Status is a debug-signed Android preview only. Build, static security tests,
pure Java permission-gate checks, Tauri compile and browser UI tests should
pass before packaging. Device-specific MediaProjection/Accessibility
end-to-end and two-real-device LAN acceptance remain production blockers.


## Android v0.4.0 schema-first performance checkpoint

- Introduced bounded native Accessibility tree snapshots with metadata-only
  roles, geometry, action flags, sanitized resource IDs and no text contents.
- Added SHA-256 tree-state digest and revision/delta schema replies;
  unchanged screens send only a small unchanged-revision receipt.
- Added version-matched click-by-element-ID, stale/revoked session rejection,
  UI event invalidation and traversal limits.
- Integrated new strict schema/element RPCs across Android, TLS controller,
  selected Core Tray bridge and Tauri native WebView.
- Viewer defaults to schema-first. Screenshot is one-off explicit fallback;
  Android JPEG compression no longer runs continuously.
- Pure code/build tests are not physical-device or security certification.
  No live Core/Tray restart, release publication, or production deployment.


## v0.5.0 LAN file transfer checkpoint

- New matching Windows and Android per-file TLS protocols for offer, ordered
  chunks, finish and abort; 4 MiB file and 4096-byte chunk limits.
- No arbitrary remote read/write path. Source files must be selected on
  target by the human owner, with a distinct approval for each transfer.
- SHA-256 checked before final receiver commit. Android MediaStore Downloads
  uses IS_PENDING; Windows writes a fresh filename under a fixed subfolder.
- Tray UI supports file picker, send, receive, cancellation, progress,
  SHA-256 and native Save As with create-new/no-overwrite semantics.
- Windows-to-Windows local TLS roundtrip test uses temporary fixtures and
  validates approval, integrity, bidirectionality, denial and cancellation.
- Android physical device, signed release and large streaming/resume remain
  prerequisites before declaring production readiness.
