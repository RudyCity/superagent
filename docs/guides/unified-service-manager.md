# Unified SuperAgent Service Manager — MCP + agent

One tool controls the *supported* service lifecycle and inventories all known
domains without conflating a listening PID, a saved lease, or a public URL with
process ownership. Source: `src/core/runtime/serviceManager.ts`.

## Entry points

- MCP: **`superagent_manage_services`**. In Gateway exposure it is advertised
  directly when locally permitted. Because a single endpoint can mutate, the
  entire tool is classified **dangerous**: OAuth `mcp:tools:write` plus local
  YOLO and the normal MCP allowlist are necessary, **even for status calls
  through this one tool**. Read-only callers can still use the existing
  safe `/status all` and specialized read-only MCP tools.
- Agent: **`manage_services`** available to Master, Superagent and the
  Chrome-extension agent toolset. Agent tool permission must be granted by
  the host. All mutations have `confirm:true` and a preflight plan.
- Both entrypoints use the **same implementation** and owner-specific controls;
  neither introduces a new background process, PID killer, shell dispatcher,
  remote SSH routing or automatic external tunnel cutover.

### Read-only inventory

```json
{"name":"superagent_manage_services","arguments":{"action":"inventory"}}
```

Or `manage_services({ action: "status", service: "mcp", port: 8857 })`
from an agent. Actions `inventory`, `status`, and `doctor` never
change services. The tool covers:

| Domain | Default/example port | Status source | Mutations via unified tool |
|---|---:|---|---|
| Core API supervisor | 7888 | authenticated Core control + kernel listener identity on Windows | plan, restart, rollback, drain |
| MCP HTTP/Cloudflare | 8857 in current local config; general MCP default 9227 | managed owner + kernel listener + authenticated probe | plan, **backend-only reload** on verified Reloadable Cloudflare owner |
| T-Line transport | 7891 | local health and PID comparison | unavailable: no authorized remote lifecycle protocol |
| Independent Channel Host | 7892 | verified owner discovery + health + PID | unavailable |
| Muse/Telegram independent watchers | 9225 WSS / 7892 controller | channel-host evidence only | unavailable |
| Vision UI-DETR-1 | 8095 | local /health and model_loaded | unavailable: HTTP health is not process ownership |
| Guardian | 7888 protected Core | Guardian lease (not proof of ownership) | unavailable |
| Daemon scheduler | embedded in Core | Core ownership and daemon architecture | unavailable |
| Tray | desktop process | no independent HTTP server | unavailable |
| REST/SSE & Muse Cloudflare tunnels | 7888 / 9225 | Cloudflare registry (not authenticated owner) | unavailable |
| Process supervisor | embedded | internal process registry | unavailable |

“Unavailable” means the manager rejects `start`/`stop`/`restart`
with `SERVICE_UNSUPPORTED_MUTATION` rather than pretending a lifecycle
operation occurred or using a speculative PID. Use documented local service
controls where available and obtain explicit owner authorization.

### Restart Core (never touch MCP ingress)

Call a read-only plan:

```json
{"name":"superagent_manage_services","arguments":{
  "service":"core","port":7888,"action":"plan","targetAction":"restart"
}}
```

The response returns `operationId`, `expectedBuildDigest`,
`supervisorPid` and `activeWorkerPid`. After operator approval:

```json
{"name":"superagent_manage_services","arguments":{
  "service":"core","port":7888,"action":"restart","confirm":true,
  "operationId":"<id from plan>","expectedBuildDigest":"<digest from plan>"
}}
```

The result verifies the supervisor generation, new worker fingerprint and
retained old session owner. Always reuse the **same operationId** after
a response timeout. This is an opt-in Core supervisor rolling restart,
not a restart of the interactive CLI/T-Line, LLM state or MCP server.
It refuses an unsupervised Core, mismatched port/owner and stale build.

### Reload MCP backend without changing URL

This **only** works on an owner verified as Reloadable:

```json
{"name":"superagent_manage_services","arguments":{
  "service":"mcp","port":8857,"action":"plan","targetAction":"reload"
}}
```

The plan supplies `operationId`, `expectedOwnerPid` and
`expectedPublicUrl`. After explicit approval:

```json
{"name":"superagent_manage_services","arguments":{
  "service":"mcp","port":8857,"action":"reload","confirm":true,
  "operationId":"<id>","expectedOwnerPid":12345,
  "expectedPublicUrl":"https://your-verified-url.example/mcp"
}}
```

The manager authenticates the owner, verifies that the public URL and PID
remain unchanged, and calls the existing **backend-only** reload. A bounded,
private, exclusive-operation journal blocks concurrent requests and uncertain
results after crashes; completed retries do not cause duplicate reloads.
It records only hashed operation IDs/URLs and PIDs, not tokens.

**Legacy MCP restriction:** The connected port 8857 was Legacy on the
2026-11-04 audit. A Legacy Cloudflare Quick Tunnel cannot guarantee the
same random hostname across a full restart, so this tool **does not**
stop/restart/migrate that tunnel. Source deployment alone does not make
this tool appear in a running Legacy backend. Consult the separate
[Core/MCP development cutover runbook](core-mcp-development-self-restart.md)
before staging a separately approved named-tunnel migration.

### Security and failure behavior

- Single-target mutations only. Never `restart all`, arbitrary kills,
  opportunistic port adoption or auto-install system services.
- MCP `read` scope alone cannot see/call this mixed-mode tool.
- Input is a bounded literal service name, action and port; no shell strings,
  arbitrary paths, project IDs, hostnames or remote workspace routing.
- A plan is **not** human approval; `confirm:true` and explicit operator
  authorization are both necessary. Unknown ownership fails closed.
- `start`/`stop` on services that lack authenticated independent
  lifecycle controls are intentionally unsupported, not simulated.
- Every mutation returns a receipt or explicit error; no fabricated success.

### Verification

```bash
bun run build
bun --bun x vitest run tests/serviceManager.test.ts tests/serviceManagerMcp.test.ts tests/serviceReloadLedger.test.ts tests/coreLifecycleOAuthHttp.test.ts
```

The OAuth loopback integration starts only an isolated Core supervisor and
MCP HTTP server on disposable ports. It tests the unified manager via the
real OAuth MCP transport, including verified rollback and idempotent retry.
No production or public tunnel is modified.
