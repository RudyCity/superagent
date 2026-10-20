# Chrome CDP Terminal — read, write, execute, observe, and Electron adapter

Updated 2026-10-20. Implemented in SuperAgent native `control_chrome_cdp` and
the `superagent_chrome_cdp` MCP tool. Restart/rebuild the MCP service to load the
new command schema. This is **CDP web-terminal automation**; it does not grant
access to independent OS terminal processes.

## Commands

| Command | Behavior |
|---|---|
| `read_terminal` | Bounded output and pane identities (`terminalId`) |
| `read_terminal_delta` | Pull newly observed output and monotonically increasing cursor |
| `write_terminal` | Focus existing web-terminal input and send CDP text; `enter:true` required to submit |
| `send_terminal_key` | Real CDP keyDown/keyUp for Enter, Ctrl+C/D/L, navigation and edit keys |
| `execute_terminal` | One command, optional shell-specific exit marker, bounded output observation |
| `watch_terminal` | Long-poll changes to a pane, up to 15 seconds per call; call again for longer tasks |
| `list_terminal_sessions` | Recent target/pane metadata, cursor and recorded dispatch types |
| `monitor_terminal_agents` | Session subset with heuristic CLI agent signatures, **not** verified PIDs |
| `clear_terminal_sessions` | Clear in-process observation metadata; never terminates programs |
| `recover_terminal` | Reconnect/validate pane; optional unique-pane rebind after renderer reload |
| `discover_desktop_targets` | Probe up to 8 **explicit** local Chromium/Electron CDP ports without launching apps |

All MCP calls use `command` plus JSON-string `payload`. Native tool calls may
also pass the command options at top level. `targetId` selects the CDP page;
`debug_port` selects the loopback port (default configured Chrome port 9222).

## Quick start

1. Run `{"command":"list_targets"}` to obtain the exact `targetId`.
2. Run `{"command":"read_terminal","targetId":"<targetId>"}`.
3. Select the `terminalId` returned. It is opaque and stable across DOM pane
   reorder, but intentionally becomes invalid after page navigation/reload.
4. Type without submitting:

```json
{"command":"write_terminal","targetId":"<targetId>","payload":"{\"terminal_id\":\"<terminalId>\",\"text\":\"npm run build\"}"}
```

5. Submit a command through CDP and observe output:

```json
{"command":"execute_terminal","targetId":"<targetId>","payload":"{\"terminal_id\":\"<terminalId>\",\"text\":\"npm run build\",\"wait_ms\":12000,\"verify_shell\":\"posix\"}"}
```

Use `"verify_shell":"powershell"` for PowerShell, or omit `verify_shell`
when the underlying shell is unknown. The shell marker is appended to the typed
command and the result is `exit_code_observed` only if an independent marker line
is visible **after dispatch**. An `expected_output` match is output evidence,
not proof that the command exited with status zero. If no completion signal
arrives in the bounded wait, `exitCode` remains `null`.

For long-running commands:

```json
{"command":"watch_terminal","targetId":"<targetId>","payload":"{\"terminal_id\":\"<terminalId>\",\"wait_ms\":15000}"}
```

For shell-marker executions, the pending marker is remembered in-process across
successive `watch_terminal` calls. A duplicate `execute_terminal` on that
pane is rejected while the marker is pending unless explicitly overridden with
`force_new_command:true`. Only one writer at a time is allowed per CDP target
inside a SuperAgent process. This is **bounded long polling**, not a background
WebSocket/SSE push subscription; no terminal is polled when nobody requests it.

## TLine / Electron desktop

TLine integration is **conditional**: the application must expose a Chromium
DevTools endpoint (for example, via an app-supported
`--remote-debugging-port=9223` launch option). Availability varies by the
actual TLine build and process configuration; do not assume it is exposed.
Do not kill or restart a user's existing desktop process automatically.

Discover only explicitly specified ports:

```json
{"command":"discover_desktop_targets","payload":"{\"debug_ports\":\"9222,9223\"}"}
```

Discovery accepts both HTTP 200 JSON and HTTP 426 WebSocket-upgrade responses.
If an endpoint upgrades but never sends targets, it reports a timeout and does
not guess that the application is usable.

Then list and select the exposed renderer on the correct port:

```json
{"command":"list_targets","payload":"{\"debug_port\":9223}"}
```

Pass that same `debug_port` and the exact `targetId` on all subsequent
read/write/watch/execute calls. A missing desktop CDP port produces an explicit
error and does **not** launch another Chrome instance. Port probing is
localhost-only; target URLs and tab names are descriptive, not trusted
authentication. Use CDP only on trusted local debugging ports.

This adapter supports Electron CDP **renderer targets**. If TLine uses a native
PTY or a cross-process terminal that exposes neither accessible DOM rows nor
an xterm buffer, CDP cannot read its output without an application-side bridge.
Remote-debugging enabled on an application should not be exposed to a public
network interface.

## Safety and limitations

- **Exact target required for writes** whenever CDP exposes multiple tabs.
  Selecting `terminal_id` is preferred to a numeric pane index. The reader
  and writer now agree on unfiltered pane indices.
- `write_terminal` never automatically sends Enter; `execute_terminal`
  always sends Enter after validating the command. Multiline/control-character
  pastes are rejected, with a maximum of 4,000 inserted characters.
- Simple destructive-command patterns (rm -rf, git reset --hard, shutdown, etc.)
  require an explicit `allow_dangerous:true`. This is a risk warning, **not a
  sandbox or a comprehensive shell security policy**; user review is still
  necessary when running consequential commands.
- No text is faked for inaccessible canvas-only terminal content. Readable
  sources are explicit xterm.js buffer instances or xterm/hterm/DOM accessibility
  rows; each output is bounded to 200 lines and 20,000 characters maximum.
- The terminal session cache is **in-memory only**, limited to 80 sessions,
  20,000 characters of recent output each, and an inactivity TTL of 30 minutes.
  No transcripts or commands are persisted by this feature. Do not treat CLI
  agent text signatures as verified running processes.
- CDP input completion is **not** a shell execution guarantee. Without an
  observed marker/validated shell integration, never fabricate exit codes or
  declare tests/builds successful.
- Recovery after renderer reload requires `recover_terminal`; opt-in
  `rebind_on_reload:true` works only when precisely one pane is detectable.
  It does not resume a killed shell or an OS process.
- Cross-origin iframe content cannot be read from the parent frame via simple
  Runtime.evaluate. The desktop app may require its own CDP target.

## Verification

```sh
bun x vitest run tests/chromeCdpTerminal*.test.ts tests/chromeCdpDesktop.test.ts tests/chromeCdpTools.test.ts tests/chromeCdpSnapshotAccessibility.test.ts
bun run build
```

A mock CDP server, a mock Electron HTTP endpoint, and a mock HTTP 426 WebSocket
endpoint are tested. Actual TLine
Desktop input/PTY compatibility must be tested with that application running
with its debugging endpoint enabled; it is not proven solely by these tests.
