# SuperAgent Tray — Connected MCP Agents

The panel is in **Overview → Connected MCP agents** and
**Runtime Detection → MCP → Connected MCP agents**.

## Evidence rules

- Source: current live MCP HTTP session registry in the independent MCP
  backend, sampled into private owner-worker IPC every 5 seconds.
- Data reaches Tray only through the selected authenticated Core's
  **verified managed MCP owner** status. The owner authenticates with its
  private loopback nonce and verifies recorded listener PID/birth identity.
- If owner verification, backend freshness (15 seconds), session count,
  or per-generation reconciliation fails, the panel says **Unavailable**.
  Old identity sightings from Access Manager are never assumed online.
- MCP initialize `clientInfo.name` and version are **untrusted claimed
  labels**, not cryptographic proof the caller is ChatGPT/Gemini/Claude.
  OAuth and static Bearer are independently authenticated. A client can
  claim any brand name.
- Each listed row has an opaque session handle, opaque principal handle,
  reported client name, authentication mode, `active`/`idle`/`retiring`
  state, in-flight request count, last observed activity and last
  *requested* tool name (no arguments).
- Raw MCP session IDs, bearer tokens, credential hashes, prompts, tool
  arguments and raw OAuth subjects are **not** sent to the Tray list.
- The panel is read-only. Session lifecycle follows existing authenticated
  MCP ownership and per-client approval; Chat Agent YOLO is not MCP access.
- Runtime source changes do not update an installed Tray/MCP backend.
  Do not restart, rotate or migrate a live MCP owner merely to display this
  feature without owner-aware release gates and explicit approval.

## Verification

Focused source tests are in
`tests/mcpSessionRegistry.test.ts`,
`tests/mcpHttpTransport.test.ts`,
`tests/mcpReloadableOwner.test.ts`, and
`tests/desktopOverviewOperations.test.ts`.
The installed native Tray and managed MCP service must be tested after
a separately approved build/release before declaring Runtime Verified.
