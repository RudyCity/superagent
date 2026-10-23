# T-Line startup / SuperAgent Motion Studio compatibility handoff

Date: 2026-10-21
Repositories: RudyCity/superagent (engine), RudyCity/t-line (desktop).
Status: Documentation handoff, not an installed-desktop acceptance test.

## Architecture and revisions

SuperAgent provides the independent Motion Studio engine, HTTP API, CLI and MCP tools. T-Line is a separate project with its own local Express backend and native Windows desktop editor. T-Line main commit 9745b01 hardens startup by authenticating the process listening on TCP 5779, instead of treating any open port as a valid backend.

The identity challenge is implemented in T-Line backend/src/backendIdentity.ts and desktop-tauri/src-tauri/src/backend_identity.rs, **not** in SuperAgent. A fresh-nonce HMAC proof verifies possession of a per-session local token without sending it to an unknown listener. The launcher attaches to a verified T-Line backend without owning it, leaves unverified port occupants untouched, and stops or restarts only child processes spawned by the current T-Line instance. A native Retry request must refuse to return a privileged navigation URL for an unverified listener.

An older, otherwise functioning T-Line backend without this endpoint is intentionally **incompatible** with the new launcher. This is a compatibility refusal, not evidence of a malicious application. Never restore unverified port probes or force-kill a PID based on port number.

## Safe operator rollout

1. Check SuperAgent and T-Line revisions independently and preserve running Hermes/Muse or customer-facing sessions. Do not restart a live service just to run a build.
2. In SuperAgent run bun run build and run the Motion regression suite (bun x vitest run tests/motion*.test.ts). These validate the engine and must not be misreported as a live installed T-Line test.
3. Build the **T-Line** Express backend and native launcher from the same updated T-Line revision. Verify Rust tests and the NSIS content checker. The Windows NSIS should contain the matching backend, verified bundled Bun runtime and Bun-compatible dependencies (not a Node executable).
4. During an authorized maintenance window, shut down the specific old T-Line instance by its owner/service controls and launch the updated desktop. Do **not** terminate arbitrary processes bound to port 5779.
5. On a disposable Windows profile, test secure startup, foreign-port conflict, verified external attach, Stop/Restart ownership, WebView2, workspace authorization and local Motion render/playback before declaring production readiness.

## Verification and outstanding gates

At this handoff, SuperAgent v1.14.8 compiled with bun run build; 21 Motion test files passed 103 tests. SuperAgent had no pending tracked source changes prior to this documentation. Desktop startup was changed and pushed separately under T-Line commit 9745b01. No running backend or tunnel was restarted by this documentation-only update.

Installed Windows/Tauri/WebView2 smoke, signing/update trust, live vision provider, Piper voice integration and long-run crash recovery remain separate acceptance gates. A passing build is not a production certificate.
