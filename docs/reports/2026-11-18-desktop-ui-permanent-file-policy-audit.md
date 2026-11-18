# SuperAgent Desktop UI / MCP permanent file-policy v2 audit

**Date:** 2026-11-18  
**Scope:** Windows SuperAgent Tray desktop UI access through the connected SuperAgent MCP gateway, under an active permanent file-policy v2 registry. Audit is read-only except for the narrow source/test/documentation commits described below. It is not a claim of local release or full Windows end-to-end coverage.

## Observed live evidence

- Core v1.14.105 and Tray were authenticated/active; current Core compiled build marked `fresh:true`, with no Core source/runtime version drift. This attests Core only; it does **not** attest the active Tray webview resources or their exact Git SHA.
- The connected identity had `superagent:read` plus `mcp-connection:execute` grants. MCP grant status was **not** the remaining blocker.
- `superagent_desktop_ui({command:"probe"})`: success on Windows with screenshot, accessibility and input capabilities reported as *available*; this is device capability discovery, **not authorization** to use them.
- `find_window`: succeeded and returned the running SuperAgent Tray process/window metadata.
- `get_active_window`: succeeded; active window reported as the SuperAgent Tray.
- `inspect_security_prompts` with **no extra fields**: succeeded with zero observed prompts. A prior call with `limit:10` was denied by the file-policy argument allowlist; the limit argument is not supported for that command.
- `inspect_window` (exact PID/HWND), `open` (even `allowInput:false`), and `focus_window`: denied by `Tool is not certified for permanent file access restrictions`. No screenshot, window schema or input action was returned or executed.
- No additional permission grant, restart, deployment, process kill or local file mutation was performed.

## Root cause — confirmed in source

1. `src/core/mcp/superagentMcpServer.ts` checks `registeredFileToolGate` at the authenticated MCP call boundary, including dynamic `superagent_tool_execute` targets, before native Desktop UI dispatch. Human-approved MCP Execute grants cannot bypass this independent host gate.
2. `src/core/tools/registeredFileToolGate.ts`: `CERTIFIED_DESKTOP_DISCOVERY` permits only `probe`, `list_windows`, `get_active_window`, `find_window`, `list_installed_apps`, `live_inventory`, and `inspect_security_prompts` with strict argument allowlists. Other Desktop UI operations remain fail-closed.
3. `src/core/tools/desktopUiTools.ts`: `inspectWindow` is **not metadata-only**: it opens a scoped session, invokes `snapshot`, and returns a `DesktopUiSchema` even when `includeScreenshotImage:false`. Consequently, allowing it under the general metadata certification would expose window contents that can include denied files or credentials.
4. `openSession`, `snapshot`, and `action` already have target identity, view/input registration and host consent logic, but these checks cannot establish that *all pixels or UI text* are free of protected file content. Registered desktop view/input and file-path deny rules are independent boundaries.
5. `focus_window` modifies the desktop state and is intentionally not covered by metadata discovery. Treating it as a harmless query would be an incorrect privilege escalation.

## Risk / gap matrix

| Priority | Finding | Evidence | Safe disposition |
|---|---|---|---|
| P0 functional gap | General MCP desktop semantic inspection and click-through are unavailable with file-policy v2 active | Live denied `inspect_window/open/focus_window` plus explicit gate | **Keep denied**, implement genuine host-native file-policy-aware mediation before expanding certification |
| P1 observability | Generic `not certified` error conflated a malformed safe metadata call (`inspect_security_prompts` with `limit`) with an inherently restricted operation | Live denied with extra parameter but success without it | Fixed in source with bounded, redacted diagnostic branches and tests |
| P1 Tray acceptance | Notification Center navigation cannot be verified via general MCP Desktop UI even when Tray code exists locally | Desktop input/UI schema denied before dispatch | Add **Tray-owned**, self-scoped, metadata-only navigation test/receipt interface; no arbitrary window screenshot or click privilege |
| P1 host mediation design | Exact HWND/PID, registered app permission and host human consent do not by themselves prevent a screenshot containing denied file bytes/text | `inspectWindow` calls `snapshot` | Require host-native source ownership + file/content mediation and revocation semantics; no blanket command allowlist |
| P2 discovery clarity | A dangerous tool can advertise both capability and disabled actions depending on policy | `action_dependent` tool readiness and MCP Execute grant are distinct | Expanded readiness description to explain exact permitted commands and remaining restrictions |

## Source changes in this audit

- `registeredFileToolGate`: no change to allow/deny outcome. An allowed metadata-only command with unsupported arguments now reports a bounded shape error; truly unmediated window contents/sessions/input report explicitly that MCP Execute cannot override file policy. Caller-supplied title, text, paths and tokens are **never echoed** by this diagnostic.
- `describePermanentFileToolReadiness`: now explicitly names `get_active_window`, the correct zero-extra-arguments shape for `inspect_security_prompts`, and why `inspect_window` is protected even when `includeScreenshotImage:false`.
- `tests/desktop-ui-integration/registered-file-tool-gate.test.ts`: regression coverage for the exact two cases, nested tool execute, redacted errors, safe metadata continuation, and denied `open/snapshot/action/focus_window`.

## Proposed acceptance requirements for full Desktop UI enablement (not yet implemented)

1. Design a native host broker with an auditable policy for any window content that might show protected files. File-access deny rules remain stronger than desktop view/input grants. No raw arbitrary screenshot, DOM/UIA text, process shell, or unbounded filesystem reads.
2. Separate **self-owned Tray metadata-only navigation verification** from arbitrary desktop input. It should be restricted to the verified Tray PID/executable digest and exact window handle, emit only allowlisted page/tab IDs, notification ID hash or opaque internal ID, and an explicit navigation receipt. It must not execute approve/deny, restart, retry or grant.
3. If arbitrary input is eventually mediated, require independent OAuth, `mcp-connection:execute`, verified target identity, attended host approval for the precise window/action, fresh revision/hash, expiry/revocation, and complete negative tests for untrusted window contents and protected paths.
4. Run targeted Vitest and typechecks, full CI, an installed Windows Tray end-to-end test through the actual authenticated MCP client, then a separately verified release. Never declare a Git commit to be runtime-verified.

## Verification honesty

**Source changes committed:** yes. **Connected live metadata acceptance:** yes for `probe`, `find_window`, `get_active_window`, `inspect_security_prompts`. **Local test execution / GitHub CI:** not confirmed. **Installed Tray notification click-through through Desktop UI:** **blocked by design**, not tested. **Desktop file-aware mediator:** not implemented. No guarantee of full desktop control is implied.
