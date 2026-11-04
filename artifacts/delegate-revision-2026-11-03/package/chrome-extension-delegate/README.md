# SuperAgent Delegate — isolated ChatGPT extension

This extension is entirely separate from `chrome-extension/`. It contains only
`manifest.json`, `background.js` and `content.js`.

## Setup

1. In Chrome, open `chrome://extensions`, enable Developer mode, and
   **Load unpacked** from `chrome-extension-delegate/`.
2. Keep a logged-in `https://chatgpt.com/` tab open in the same Chrome profile.
3. Open SuperAgent in a **single-agent** T-Line or extension-chat session.
   The first `delegate.*` invocation starts a loopback WebSocket listener
   at `127.0.0.1:17341`. The extension reconnects while its worker runs.
4. Run `list_tools({query:"delegate"})` and
   `describe_tool({names:["delegate.create_chat","delegate.read_chat","delegate.send_message","delegate.stop_generation"]})`.
5. Optional defense in depth: find this unpacked extension's ID on
   `chrome://extensions` and start the server with
   `SUPERAGENT_DELEGATE_EXTENSION_ID=<id>`; the bridge then rejects other
   extension origins.

## Behavior and boundaries

- The only site-specific content script runs on **chatgpt.com**.
- The bridge uses a fixed RPC allowlist. It never executes arbitrary JavaScript
  or accesses cookies, credentials, or non-ChatGPT tabs.
- **create_chat** requires an existing ChatGPT tab and clicks the New chat
  control once. Missing tab, missing control, or login required yields errors.
- **read_chat** returns visible turn text, latest assistant response, and status.
- **send_message** clicks Send exactly once. After a timeout, network loss or
  unknown delivery it never resends; call read_chat before a new explicit send.
- **stop_generation** is only available by an explicit tool call. A timed-out,
  disconnected, or aborted request does not stop generation.
- No DOM reload recovery, scripting into page contexts, or modification of
  `chrome-extension/`.
- ChatGPT may change its DOM. The selectors should be maintained against the
  actual UI; selectors are heuristic and not a public API.
- Local origin restrictions are not cryptographic authentication. For shared
  machines, set the extension ID restriction and block untrusted local clients.
- Model providers may reject dotted tool names; test your selected provider
  before relying on native function calling.


## Verification

Run from the SuperAgent workspace root:

```powershell
bun --bun x tsc --noEmit
bun run verify:extension-js
bun --bun x vitest run tests/delegate.test.ts tests/delegateContent.test.ts tests/extensionChatToolFilter.test.ts
bun scripts/verify-delegate-discovery.ts
```

The discovery smoke script verifies all four delegate tools in single-agent
T-Line and Chrome-extension chat and confirms they are absent from
T-Line Master mode. The 12 existing Chrome-extension-only tools remain
filtered in T-Line. Tests do not open a browser or send a ChatGPT message.

A live end-to-end check requires a running Chrome instance with the
unpacked extension installed and a logged-in ChatGPT tab. DOM selector
compatibility cannot be claimed from simulated-DOM tests alone.

If the composer contains an unsent draft, delegate.send_message returns
CHATGPT_DRAFT_PRESENT instead of overwriting it.
