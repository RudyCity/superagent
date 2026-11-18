# SuperAgent Tray — Connected MCP Agents

The panel is in **Overview → Connected MCP agents** and
**Runtime Detection → MCP → Connected MCP agents**.

## Evidence rules

- Source: current live MCP HTTP session registry in the independent MCP
  backend, sampled into private owner-worker IPC every 5 seconds.
- Data reaches Tray only through the selected authenticated Core's
  **local-operator-only** `/api/desktop/access/connected-clients` endpoint
  and the main native Tray `mcp_project_access_action("connected_clients")`.
  General MCP service status only reports aggregate counts. The endpoint
  rechecks the verified managed MCP owner's status. The owner authenticates with its
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
- **MCP Connections → Koneksi MCP Tercatat** maintains a separate bounded,
  metadata-only, 30-day history of opaque credential connection handles.
  It reconciles only after the native Tray makes a local authenticated Core
  request and the selected MCP owner's complete session inventory is verified.
  The same public `/mcp` URL may have simultaneous ChatGPT, Gemini, or other
  clients with different tokens: each credential handle is recorded separately,
  and multiple sessions using one credential are counted under that handle.
  Registration is on verified inventory observation, **not** on receiving an
  arbitrary Authorization header or clientInfo string. A connection that starts
  and ends without being observed may not appear in the history.
- An offline/unavailable owner **never** turns old records into verified online
  connections. The UI labels them as unverified historical sightings. The
  persisted file stores no access tokens, credential hashes, raw OAuth client
  IDs, raw session IDs or public MCP URL. A reported app name is always marked
  as client-claimed; it is not evidence that a connection really belongs to a
  specific AI vendor.
- **Registration is not authorization.** The grantable identities panel comes
  from existing Core requests/operator-approved identity proofs; a live
  credential handle does not let the user or agent bypass the explicit
  Security Approval request. OAuth project grants still follow the
  authenticated OAuth client ID; session/token handles are for telemetry
  and are never independent permission grants.
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

## Diagnosing a failing MCP connection (without changing running services)

A GitHub commit or green MCP CI does not update the installed MCP backend.
The independently owned backend and the selected public URL must first pass
local owner verification. Never infer that an agent is active from an old
Access Manager identity or a stale session record.

For **attended, read-only verification** on the actual SuperAgent host, use
`bun scripts/mcp-tool-policy-live-verify.ts` with these operator-provided
environment variables:

- `SUPERAGENT_MCP_POLICY_LIVE_ACCEPTANCE=1` — explicit opt-in for the probe
- `SUPERAGENT_MCP_POLICY_URL` — the reviewed MCP URL ending in `/mcp`
- `SUPERAGENT_MCP_POLICY_PORT` — locally verified owner port
- `SUPERAGENT_MCP_POLICY_BEARER_TOKEN` — current host-provided credential
- `SUPERAGENT_MCP_POLICY_EXPECTED_RELEASE_DIGEST` — **actual** SHA-256 of
  the staged/activated backend release, not the Git commit ID

Do not paste the token into chat, commit it, or include it in screenshots/logs.
The script never changes grants, files, Core, Tray, remote devices, or browser
sessions. It verifies the owner on both sides of the HTTP read-only probe,
including matching owner/backend PIDs and the exact release digest.

A `BLOCKED` result includes a redacted `phase` and `code`, not raw HTTP
errors or credentials. The phases are `preflight`, `owner`,
`mcp_connect`, `mcp_catalog`, `mcp_status`, and `owner_postflight`.
Common codes:

| Code | Meaning / next safe step |
| --- | --- |
| `OPERATOR_OPT_IN_REQUIRED` | The attended preflight has not been explicitly enabled |
| `UNVERIFIED_MCP_OWNER` | Check the native Tray service status, listener identity and owner/backend health; do **not** adopt an arbitrary PID |
| `MCP_BACKEND_RELEASE_DIGEST_MISMATCH` (owner reason) | The active backend is not the reviewed release artifact; do not claim a successful upgrade |
| `MCP_POLICY_AUTH_REJECTED` | Inspect the actual OAuth/static-bearer connection approval and authentication mode without sharing credentials |
| `MCP_POLICY_CONNECTION_REFUSED` | Verify the expected listener and independently owned backend are up; do not restart blindly |
| `MCP_POLICY_DNS_UNAVAILABLE` / `MCP_POLICY_TLS_REJECTED` | Validate named/quick tunnel configuration and certificate using a non-secret challenge |
| `MCP_POLICY_LIVE_TIMEOUT` | Investigate transport, tunnel, backend drain and worker health |
| `MCP_OWNER_CHANGED_DURING_ACCEPTANCE` | A backend or owner generation changed during the probe; treat the receipt as invalid and check active sessions |
| `MCP_POLICY_LIVE_FAILED` | Generic unknown error; inspect local owner log privately before making changes |

If ChatGPT's connected tool reports only *"The tool failed internally"*, that
is not proof of a permanent-file-policy refusal: the request may not have
reached the MCP tool dispatcher. Separate transport/authentication failures
from explicit `Tool is not certified for permanent file access restrictions`
errors observed after dispatch. Permission troubleshooting must never change
Chat Agent YOLO to grant an MCP identity additional privileges.
