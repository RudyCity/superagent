# Trusted Desktop Input — Security Approval Manager

**Date:** 2026-11-14
**Status:** Implemented in source; not automatically installed or activated in the running Tray/Core.

## What "Trusted" actually means

Trusted is the default **request mode**, not permanent permission to click/type. A newly installed Tray defaults to `trusted` with **zero approved windows**, so native input remains denied.

For one exact verified window, the owner may allow the *opportunity to request consent* for **5, 10, 15, or 30 minutes**. The native Tray dialog asks the owner to confirm the application name, exact PID, native window ID, title and expiry. It never grants native input itself.

After that, when a desktop UI tool opens the trusted window:

1. The Core reads the local `desktop-input-trusted.json` preference in `SUPERAGENT_CONFIG_DIR` or `~/.superagent-r`.
2. The Core matches the **exact PID, native ID, app name and title** against a fresh native OS window inventory. The window must be foreground for an input session.
3. Core displays a **second native host dialog** identifying the requester and window and giving the operator a **Deny** option (default).
4. Only a real, affirmative approval creates a **session-token-scoped** Core consent grant, with a TTL no longer than either the requested session or the remaining Trusted window deadline. This does not authorize an application-wide lifecycle operation.
5. Every semantic click, type, key or scroll still requires the current session, screenshot revision and SHA-256 screenshot hash. Core re-reads the Trusted policy on **every input action**. Revocation or expiry immediately blocks the next action, even for an already open session.
6. Closing or expiring a session destroys its temporary trusted grant. `allowInput:false` always forces read-only. Omitting `allowInput` requests host consent only if an exact, still-valid Trusted entry exists. An untrusted or unknown window remains read-only.

**No app name alone is sufficient.** Neither the browser WebView nor an MCP parameter can invoke the Core consent-grant method. Legacy host-controlled exact-target environment grants remain separate and retain their existing requirements.

## How to use in Tray

1. Open **Tray Settings → Security Approval Manager → Trusted Desktop Input**.
2. Keep **Trusted** selected and click **Save mode**. This does not enable input for any window.
3. Click **Refresh windows**. The list comes from the authenticated local Core's real OS window inventory.
4. Choose one window and select an expiry (10 minutes is a reasonable default).
5. Click **Review & Trust window** and explicitly approve the native host dialog. Declining leaves the target untrusted.
6. In the actual desktop UI tool, request input or omit `allowInput` for the already trusted exact window. **A second local native prompt appears**. Approve only if you expect this specific request.
7. To stop further input, click **Revoke** next to the window, **Revoke all windows**, or change the mode to **Off**.

If the target application restarts and obtains a different PID or native window ID, the old entry will **not** authorize a different window. Re-select and approve it. Changing Trusted mode or the target list does not require a Core restart once this code is installed in the running Core.

## Security ownership and persistence

- The policy lives in `desktop-input-trusted.json` within the established SuperAgent config directory. It contains only a bounded versioned mode, native window identities, observed display metadata and expiration timestamps. It contains **no bearer tokens, credentials, passwords or remote-viewer information**.
- Rust rejects unknown fields, symlinks, oversized files, invalid TTLs, duplicate native identities, non-regular files, and more than 16 target entries. Writes are atomic.
- The Core treats the policy as **untrusted request eligibility only**: it independently validates the file, re-discovers the OS identity and prompts the attended host. Malformed/missing files and native dialog errors all fail closed.
- Native input is never enabled for arbitrary windows or a whole process by a new global setting. A signed user session does not bypass host consent.
- OS elevation prompts, UAC, firewall grants, accessibility permissions, mobile device pairing, and remote desktop viewer/control authorizations are **not** bypassed or included.
- Running installed binaries must actually be updated before the feature is usable. Editing source files alone does not change an already running Core/Tray process. Preserve the existing primary runtime and complete release gates before replacing the installed binaries.

## Implementation

| Layer | Code |
| --- | --- |
| Tray UI | `apps/superagent-tray/ui/desktop-input-trust.js`, `desktop-input-trust.css`, `index.html` |
| Native Tauri host approvals + exact discovery | `apps/superagent-tray/src-tauri/src/desktop_input_trust.rs`, `src/main.rs` |
| Safe shared policy reader | `src/core/tools/desktopTrustedInput.ts` |
| Native per-session prompt | `src/core/desktopUi/trustedInputPrompt.ts` |
| Core session + per-action revocation | `src/core/tools/desktopUiTools.ts` |
| MCP optional auto-request | `src/core/mcp/tools/desktopUiMcpTools.ts` |
| Tests | `tests/desktop-ui-integration/trusted-desktop-input.test.ts`, `tests/desktopTrustedInputTrayUi.test.ts`, Rust unit tests in `desktop_input_trust.rs` |

## Verification and rollout caveats

- Run TypeScript `bun --bun x tsc --noEmit`; focused Vitest including existing Desktop UI security tests.
- Run `bun run build` (Core/CLI) and native Tauri `cargo check` / `cargo test` in the actual Windows build environment.
- End-to-end attended Windows Tray dialog, direct keyboard/mouse action in Antigravity, and installed-binary certification require an operator present on the desktop. Tests do not simulate a real human approval.
- Do not reset/rebase/clean a shared checkout, commit unrelated workers' files, restart shared Core/MCP/Tray, or claim the installed runtime already uses this change.
