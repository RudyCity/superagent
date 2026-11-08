# Native Desktop MCP Integration

Date: 2026-11-08

## Scope

The native desktop module remains implemented under `src/core/desktopUi/**`. This integration exposes that module through the local SuperAgent tool `desktop_ui` and the MCP tool `superagent_desktop_ui` without changing the native adapter implementation.

Chrome and Electron browser automation continues to use the existing protected CDP/Delegate tools. Native desktop MCP does not add a second CDP path for operating-system applications.

There is intentionally no window-discovery tool in this integration. The caller must already know the exact process ID and native window ID from a trusted host-side source.

## Security model

`superagent_desktop_ui` is classified as **dangerous**. MCP discovery and execution therefore remain subject to the existing dangerous-tool policy:

- YOLO OFF blocks execution.
- Safe-only MCP owners do not expose the tool.
- OAuth callers require `mcp:tools:write`.
- Existing MCP allowlists and gateway authorization still apply.

The desktop dispatcher receives a server-derived principal ID. A desktop session token is stored with that principal and cannot be snapshotted, acted on, or closed by another principal. Stateful MCP transports use their authenticated identity; local stdio receives a transport-scoped local principal. Caller-supplied client names are not authorization.

Native desktop execution is host-local. If the effective MCP workspace is an `ssh:` or `chain:` target, the desktop tool returns `LOCAL_HOST_REQUIRED` before calling a native adapter.

## Target and consent scope

Every session requires:

- positive integer PID;
- non-empty native window ID;
- non-empty title metadata.

The title is descriptive only. It is never an authorization key.

Host input consent can be granted in two ways:

1. exact session token; or
2. exact PID **and** native window ID.

Title-only, native-ID-only, and PID-only grants are rejected.

Legacy global input environment flags no longer authorize every application. If one is enabled, the exact target must also appear in `SUPERAGENT_DESKTOP_UI_ALLOWED_TARGETS` as JSON, for example:

`[{"pid":1234,"nativeId":"5678"}]`

The session re-checks host consent on every action. A model-provided `allowInput:true` is only a request and cannot authorize native input by itself.

## Session lifetime

Desktop tokens are 256-bit random values represented as 64 hexadecimal characters.

TTL is absolute, not sliding. Accepted values are 60 seconds through 30 minutes. Snapshot/action activity updates last-access metadata but never extends the expiration timestamp. Closing a session immediately invalidates its token.

## Perception and screenshot handling

Snapshot responses return semantic schema by default. Raw screenshot bytes are returned only when `includeScreenshotImage:true` is explicitly requested.

The screenshot response cap is a hard maximum of 2 MiB. `maxImageBytes` may lower that limit but cannot raise it.

Vision upload is **off by default**. `enableVision:true` succeeds only when the trusted host has either:

- `SUPERAGENT_DESKTOP_UI_ALLOW_VISION_UPLOAD=true`; or
- `SUPERAGENT_DESKTOP_UI_VISION_AUTH_TOKEN` configured.

The endpoint is still constrained by the native vision module to loopback HTTP. The MCP caller cannot supply the host authorization token.

## Action contract

Actions are semantic only. Raw coordinates are not exposed in the MCP schema and common coordinate aliases are rejected before routing.

Supported action kinds are `click`, `type`, `key`, and `scroll`. Both of these forms are valid:

- `{ "action": "click", ... }`
- `{ "command": "action", "action": "click", ... }`

Every action requires the exact prior screenshot revision and a 64-character SHA-256 hash. The native session performs its own fresh target/hash validation before dispatch.

Additional integration validation:

- modifiers must be supported and unique;
- scroll deltas must be integers from -3 through 3 and cannot both be zero;
- typed text is capped at 32,768 characters;
- screenshot byte limits and TTLs are integer-bounded.

## Logging and privacy

Desktop MCP logging redacts recursively:

- `sessionToken`;
- typed `text`;
- `screenshotImage`;
- `image_base64`, `imageBase64`, and string `image` payloads;
- local vision authorization token fields.

The primary MCP log path sanitizes desktop arguments before summary logging. Audit hooks and activity events receive redacted desktop arguments/errors, and desktop result text is scrubbed before activity output is emitted.

The screenshot returned to the authorized caller is still sensitive target-window data. Redaction applies to observability/logging; it does not alter an explicitly requested snapshot response.

## Local tool registration

The local `desktop_ui` tool is registered for:

- the Superagent execution tier;
- the `software-tester` subagent tier.

It is not registered for Master or `chrome-agent`, keeping browser-specific automation on the existing browser control boundary.

## Verification boundary

Automated integration tests cover dangerous classification/safe-only hiding, OAuth write metadata, principal ownership, exact consent scope, default-deny input, fixed TTL, stale screenshot rejection, close/token invalidation, remote-workspace rejection, action grammar, raw-coordinate rejection, log redaction, vision opt-in, screenshot bounds, and local toolset registration.

Windows native input E2E now passes click, type, TAB, and wheel-scroll on a disposable WinForms window. A second E2E passes the in-process MCP dispatcher through probe/open/snapshot/click/close, including rejection of a different MCP principal. This certifies the tested Windows and in-process dispatcher paths only, not the old live Core MCP transport, macOS, or Ubuntu.

## Follow-up host verification

Actual Windows native input E2E passed against a disposable WinForms process after the fixture gained foreground focus through test-only AttachThreadInput. It verifies button click count, exact typed text, TAB dispatch, wheel dispatch without an extra click, and cleanup. The production adapter retains fail-closed PID/HWND, active-foreground, screenshot identity, and consent checks. A separate in-process MCP-native E2E passes on the same host. Neither test restarted the live Core.

Reproducible commands:

```sh
SUPERAGENT_DESKTOP_UI_READONLY_E2E=1 bun --bun x vitest run tests/desktop-ui-windows-e2e/windows-host-input.e2e.test.ts
SUPERAGENT_DESKTOP_UI_NATIVE_E2E=1 bun --bun x vitest run tests/desktop-ui-windows-e2e/windows-host-input.e2e.test.ts
```

The first command is read-only. The second additionally opens a temporary top-level test window and requires that window to be the foreground window for click, type, key, and scroll checks; it must only be run on a safe interactive desktop. Both clean up the fixture and temporary state files. No live Core/MCP restart is included in these checks.

## Input outcomes and focused-key safeguards

When dispatch might have partially succeeded, or post-action verification fails after native input was sent, the session reports DISPATCH_UNVERIFIED instead of a preflight error. Callers must never automatically retry; obtain a fresh screenshot, inspect the application state, and decide whether another action is necessary. The previous schema is invalidated.

The semantic schema includes optional focused state from accessibility providers. Non-navigation and modifier-assisted keyboard operations require exactly one currently focused actionable control; focus state must also remain consistent throughout pre-action verification. Missing or unknown focus cannot authorize mutating keys.

The opt-in real Windows read-only tests also compile generated C# SendInput P/Invoke code in PowerShell without sending GUI events. Command:
SUPERAGENT_DESKTOP_UI_READONLY_E2E=1 bun --bun x vitest run tests/desktop-ui-windows-e2e

Windows native GUI input E2E now passes with disposable test-only foreground activation. The default regression suite skips opt-in host tests. Ubuntu/macOS real-host acceptance and live Core MCP transport activation are separate outstanding gates.

## Combined Windows acceptance command

Enable both opt-in host gates with the regular desktop unit and integration suites:

SUPERAGENT_DESKTOP_UI_NATIVE_E2E=1 SUPERAGENT_DESKTOP_UI_READONLY_E2E=1 bun --bun x vitest run tests/desktop-ui tests/desktop-ui-integration tests/desktop-ui-windows-e2e

The in-process MCP native E2E verifies principal-scoped tool invocation, not deployment of the modified tool into the active Core worker.
