# Chrome CDP — reading and writing web terminals

Added 2026-10-20. The commands `read_terminal`, `write_terminal`, and `send_terminal_key` are available through the local `control_chrome_cdp` tool and the `superagent_chrome_cdp` MCP wrapper after recompiling/restarting the SuperAgent MCP server.

## Usage

```json
{"command":"read_terminal","payload":"{\"max_lines\":80,\"max_chars\":12000}"}
```

To choose a specific terminal, provide either `index` (zero-based) or `selector` (CSS). Example: `{"command":"read_terminal","payload":"{\"selector\":\"#terminal\",\"max_lines\":50}"}`. Select a specific Chrome CDP tab with the existing `targetId` option. `viewport_only:true` reads visible xterm rows from an accessible xterm buffer; the default reads newest scrollback lines.

### Writing to a terminal

`write_terminal` selects an existing terminal input (typically xterm.js's hidden textarea), focuses it, then dispatches text through native CDP `Input.insertText`. It deliberately does not call `terminal.write()`, which only paints output. Enter is **not** implicit:

```json
{"command":"write_terminal","payload":"{\"index\":0,\"text\":\"npm run build\",\"enter\":true}"}
```

To type without executing, use `"enter":false` (the default). Text is limited to 4,000 characters, and multi-line pastes are rejected to avoid accidentally executing several shell commands. When there are multiple detected terminals, provide exactly one `index` or `selector`. `targetId` selects the Chrome debugging tab.

`send_terminal_key` sends a real CDP keyDown/keyUp pair. Supported keys: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `Ctrl+C`, `Ctrl+D`, and `Ctrl+L`.

```json
{"command":"send_terminal_key","payload":"{\"index\":0,\"key\":\"Ctrl+C\"}"}
```

A success response confirms **dispatch** only, not that a PTY executed a command. Read the terminal afterward and verify its output. No automatic retries of terminal input are performed.

## Extraction order and limitations

1. Exposed xterm.js buffer: `window.term`, `window.terminal`, `window.xterm`, `window.__xterm`, `window.__terminal` or `window.terminals`. Reads `buffer.active.getLine(i).translateToString(true)`, without sending keystrokes or mutating the buffer.
2. Accessible xterm rows and DOM-rendered rows, including hterm and terminal output HTML. Detects common terminal containers, open shadow roots and same-origin iframes.
3. If the renderer paints only to canvas/WebGL and does not expose the buffer or accessibility rows, the tool returns `unavailable` and explains the limitation. CDP's DOM evaluation cannot recover characters from pixels. Use existing `screenshot`/vision tools or add a read-only buffer export in the web app.

The tool cannot inspect a native OS terminal window or a different-process Electron app unless that app exposes a compatible Chrome DevTools debugging target. Cross-origin iframe content is also not directly readable via the parent page's `Runtime.evaluate`.

## Guardrails

- `max_lines`: default 80, maximum 200.
- `max_chars`: default 12,000, maximum 20,000 shared across selected terminals.
- No polling, clipboard access, WebSocket interception, or DOM content modifications. Terminal input is only dispatched on explicit `write_terminal` or `send_terminal_key` calls.
- Writing requires a focusable terminal input reachable from the CDP target; canvas-only detection does not imply writable access.
- Returned terminal output may contain secrets; handle access and logs like other remote browser data.

## Verification

- `bun x vitest run tests/chromeCdpTerminalInput.test.ts tests/chromeCdpTerminal.test.ts tests/chromeCdpTools.test.ts tests/chromeCdpSnapshotAccessibility.test.ts`
- `bun run build`
