# SuperAgent ACP Server — Implementation Plan
Date: 2026-10-25
Status: planned (not implemented)
Scope: SuperAgent repository; ACP Agent/server role. A T-Line ACP Client is a separate project.

## 0. Objective and decision
Expose the existing SuperAgent engine as an Agent Client Protocol (ACP) agent callable from compliant clients such as Zed and eventually T-Line. Do **not** replace SuperAgent's CLI, MCP server, model/provider configuration, agent loop, security rules, multi-agent orchestrator or memory.

Use the official `@agentclientprotocol/sdk` with the stable ACP **v1** entrypoint and a pinned, tested SDK version. ACP v2 is an experimental draft; track separately without claiming compatibility. Use a dedicated Bun-native, stdio JSON-RPC subprocess initially. ACP is **client ↔ agent**; MCP remains **agent ↔ tools**. No ACP-to-MCP protocol conversion is implied.

## 1. Repository audit (read-only snapshot)
- `package.json`: SuperAgent 1.14.36, Bun >= 1.4.2, TypeScript ESM, `src/cli.tsx` → compiled `dist/cli.js`, existing Vitest suites.
- `src/core/agent.ts`: `Agent` takes `onEvent`, `onPermission`, `onQuestion`, custom tools and working directory; it exposes `sendMessage`, `abort`, `dispose`, `sessionId`, execution modes, tool scope and YOLO guards.
- `src/core/agent/AgentEvents.ts`: `text`, `reasoning`, `tool_start`, `tool_progress`, `tool_end`, `error`, `done`, `token_usage`, etc. Existing permission callback returns boolean or `"session"`.
- `src/core/mcp/superagentMcpServer.ts`: separate existing MCP provider, **not** ACP.
- `src/core/assistant/assistantTaskRuntime.ts`: detached read-only worker is explicitly constrained, and does not provide a generic mutating agent bridge.
- `docs/plans/2026-10-25-superagent-core-rolling-restart.md`: core API supervisor does not automatically migrate active in-memory agent objects or unrelated transports. Avoid claiming ACP active turn survival after process death.
- Existing multi-agent/worktrees, workspace ACLs, `yoloBlocklist`, `permissions`, agent session/history and memory mechanisms must be reused rather than bypassed.
These are integration candidates, not an assertion that existing features are already ACP-ready.

## 2. Proposed architecture
```text
Zed / generic ACP client / later T-Line ACP client
             │ JSON-RPC 2.0 / stdio (v1)
             ▼
   superagent acp serve --stdio
     ├─ ACP transport, initialize + capability negotiation
     ├─ ACP session manager (connection scoped)
     ├─ AgentEvent → ACP notification mapper
     ├─ Permission + question bridge
     ├─ cwd/workspace trust + scoped session policy
     └─ cancellation / lifecycle / cleanup
             ▼
     SuperAgent Agent + orchestrator
       ├─ configured models and credentials
       ├─ MCP manager and dynamic tools
       ├─ workspace, worktrees, locks, permissions
       └─ history / brain / rmemory
```
ACP subprocess must not mount the React/Ink TUI, start legacy fixed-port HTTP listeners, register an unrelated tunnel, or take ownership of any existing CLI/core worker.

### Suggested source layout
- `src/core/acp/acpServer.ts` — SDK ACP Agent handlers.
- `src/core/acp/acpTransport.ts` — strict stdin/stdout codec and process lifetime.
- `src/core/acp/acpSessionManager.ts` — session → Agent registry, ownership, lifecycle.
- `src/core/acp/acpAgentRunner.ts` — adapt `Agent` and safe agent modes.
- `src/core/acp/acpEventMapper.ts` — typed streaming/tool/progress map.
- `src/core/acp/acpPermissionBridge.ts` — approval/elicitation compatibility and fail-closed behavior.
- `src/core/acp/acpWorkspacePolicy.ts` — cwd, trusted root, path normalization/revalidation.
- `src/core/acp/acpConfig.ts` — flags/defaults, no secret output.
- `src/core/commands/acpCliHandler.ts` — `superagent acp ...` dispatch.
- `tests/acp*.test.ts`, `tests/integration/acp*.test.ts`, `scripts/verify-acp-zed-smoke.ts`.
Adjust file names after checking established local naming conventions; avoid a parallel general-purpose runtime.

## 3. Protocol feature matrix and release gates
| Capability | MVP / P0 | P1 | P2 |
|---|---|---|---|
| `initialize`, protocol v1 negotiation, info, capability gating | Yes | Regression | Regression |
| `session/new` with validated absolute cwd | Yes | Regression | Regression |
| `session/prompt` → existing `Agent.sendMessage` | Yes | Multimodal gated | More context types |
| `session/update` text/tool-call/progress | Yes | Richer plans, usage | Advanced artifacts |
| `session/request_permission` | Yes, every dangerous change | Better scoped grants | Review UX |
| `session/cancel` and tool abort | Yes | Race hardening | Recovery integration |
| `session/set_mode`, `session/set_config_option` | Only if accurately implemented + advertised | Supported modes/config | Further options |
| `session/load` or resume/history | **Do not advertise until implemented and tested** | Completed-session reload | Durable in-flight jobs if separately proven |
| `session/list`, fork and delete (where supported by pinned v1 SDK/spec) | Only advertise implemented subset | Gradual support | Optional |
| Client-provided MCP servers | Reject unsupported transport with explicit error | MCP stdio/http scoped to session | Complex multi-server policies |
| File/terminal client callbacks | Only when matching client capabilities and safe policy | Optional | Optional |
| Authentication | Use existing local provider config; never assume client credentials | ACP login flow if required | Secure remote auth |
| HTTP/WebSocket transport | No for MVP | Research/opt-in only | Authenticated loopback/remote if needed |
| Multi-agent | Keep existing runtime internal | Explicit opt-in/worktree isolation | Structured task feed |
| ACP v2 | No; track changelog | Compatibility assessment | Separate versioned handler if stable |

For v1, use the **v1** method names/response semantics; never mix v2-only `auth/login`, mandatory `session/resume`, v2 state update lifecycle, etc. with v1. Refer to the pinned ACP schema in tests.

## 4. Phase 0 — design freeze and compatibility audit
- Inventory `Agent.sendMessage` output and cancellation races, existing history/reload methods, permission callbacks and model configuration ownership.
- Validate official ACP SDK v1 under Bun, lock version with `bun.lock`, inspect license and TypeScript types.
- Decide on client capability negotiation before calling client fs, terminal, images, elicitation, or other optional extensions.
- Build small protocol fixture and inspect actual Zed/custom client handshake.
- Define explicit negative cases: invalid cwd, untrusted path, missing auth/provider key, mismatched session, unsupported method, noisy stdout.
**Exit:** interface design and support matrix signed off, no unrelated daemon/CLI behavior affected.

## 5. Phase 1 (P0) — usable local ACP server
- Add `superagent acp serve --stdio` as a **top-level** CLI branch before ordinary CLI/TUI initialization; ideally use a standalone generated `dist/acp.js` entry or import a minimal handler.
- Implement ACP v1 initialization, `session/new`, `session/prompt`, `session/update` and `session/cancel`; return spec-correct stop reasons/errors.
- One ACP session owns one SuperAgent `Agent`, a stable scoped internal session ID, cwd, AbortController, inflight turn and bounded event queue. Prevent overlapping prompts for one session; support several independent sessions with explicit resource caps.
- Map `text` to assistant chunks; map `tool_start`/progress/end to stable tool-call IDs and status. Map errors to safe summaries, completion to correct turn stop reason. Do not publish private chain-of-thought / raw model reasoning as a default.
- Map `onPermission` to client `session/request_permission` with approve-once/reject where appropriate; approve-session only after explicit client choice, restricted to equivalent scoped operations. Unknown/disconnected client, timeout or cancellation => deny. Question UX must degrade safely; do not silently autoanswer.
- Parse and validate absolute `cwd`, require trusted workspace and server-side canonical realpath/boundary checks (Windows path casing, junctions, symlinks, UNC/drives); disallow write outside allowed roots even in YOLO. Do not enable inherited ambient `yolo full` for ACP by default.
- Serialize JSON-RPC only to stdout (no React, banner, spinner, logger, crash dump); diagnostics to sanitized stderr. No secret or raw token logging.
- Clean up Agent/abort controllers/MCP sessions/file leases on `stdin` EOF, client disconnect, SIGTERM and session disposal. Never terminate unrelated CLI, T-Line, Muse, Telegram, MCP tunnel or other background tasks.
**Exit:** locally spawned ACP server chats, streams, displays tool activity, requests permission, cancels and exits cleanly.

## 6. Phase 2 (P1) — state, modes, reliability
- Persist mapping to existing conversation/history only when format is stable; implement `session/load` accurately before advertising it. Prefer replay of **completed** turns, never claim interrupted side effects completed.
- Implement mode/config selection based on actual `Agent.activeModeOverride` and session-level execution policy (e.g. ask/plan/review/implement only if all gates function). Do not expose unsupported modes.
- Resource locks, concurrency, queued event backpressure, bounded tool output/chunks, timeout, unknown error mapping, provider disconnect.
- End-to-end support for tool-call edits/diffs when available in runtime, preserving workspace mutation constraints and file locks.
- Add opt-in internal multi-agent mode with isolated worktrees, explicit write/merge approval and stable per-subagent attribution; no shared mutable workspace writes in parallel by default.
- Session load after restarting the process must handle durable history only; active operations remain interrupted until an actual externalized executor/checkpoint adopter exists.
**Exit:** reconnection/history/modes and two-client concurrency validated with real models under local staging.

## 7. Phase 3 (P2) — packaging, deployment and broader clients
- Package Bun entrypoint for Windows/Linux/macOS with deterministic binary/launcher resolution, space-containing paths and no TTY assumptions.
- Document Zed custom-agent installation, setup, workspace trust and preferred model/provider selection. Client configs must not contain API keys.
- Validate compatibility with at least Zed and a second generic ACP client/conformance harness.
- Optional ACP configuration/status commands and diagnostics; do not conflate ACP host status with MCP tunnel status.
- Prepare an ACP Client adapter in T-Line as an **independent** initiative (client launches/supervises SuperAgent or any ACP agent). Cross-client shared sessions require a separate service; stdio subprocesses are not shared automatically.
- Only after real need and security design, consider HTTP/WebSocket transport with explicit auth, origin controls, authenticated scopes, no remote unauthenticated listen socket.
**Exit:** packaged cross-platform acceptance, docs and release checklist complete.

## 8. Configuration and CLI proposal (not yet implemented)
```shell
superagent acp serve --stdio
superagent acp status
superagent acp doctor
```
Suggested safe config exposed through **existing SuperAgent config commands** (not forced `.env`):
```json
{
  "acp": {
    "enabled": true,
    "protocolVersion": 1,
    "transport": "stdio",
    "defaultMode": "ask",
    "requireTrustedWorkspace": true,
    "permissionPolicy": "ask",
    "maxSessions": 4,
    "maxConcurrentTurns": 2,
    "enableMultiAgent": false,
    "logLevel": "warn"
  }
}
```
These are proposed schema fields and may change once aligned with the real settings schema. ACP enabled must not launch a background TCP listener automatically.

Example Zed custom agent **after implementation/build**:
```json
{
  "agent_servers": {
    "SuperAgent": {
      "type": "custom",
      "command": "bun",
      "args": ["D:/backup from pc asus/Documents Development/superagent/dist/cli.js", "acp", "serve", "--stdio"],
      "env": {}
    }
  }
}
```
Prefer an installed launcher over a workspace-specific absolute path in production. This example is not evidence the command is currently supported.

## 9. Test matrix
- Protocol: valid/invalid handshake, version mismatch, malformed/batched requests as required by SDK, unknown method, capability gating, no stdout junk, non-TTY startup.
- Sessions: two sessions, distinct cwd/conversations, one turn at a time per session, session not found, client disconnect, queued/bounded notifications.
- Streaming: Unicode/multichunk, tool start/progress/end, errors, cancellation before/during model and tool, exactly one coherent stop result.
- Permissions: explicit accept/reject, disconnect and timeout deny, session-grant scope, YOLO flag ignored unless specifically configured and trusted, symlink/junction traversal rejection, sensitive file guards, no unauthorized command.
- Security: no tokens/keys in stderr or ACP updates; no writes beyond workspace; client-provided mcpServers validated and disabled if unsupported.
- Recovery: completed-turn replay only where proven; core rolling restart does not falsely report active ACP turn recovery; orphan worker handling.
- Integration: Bun build, targeted Vitest, ACP conformance/TCK if applicable, Zed fresh session, edit approval, interrupt, resume/load if supported, Windows installation paths and packaged launch.
- Regression: normal CLI, T-Line REST/SSE/WS, existing MCP tools/OAuth, Muse/Telegram watchers, memory, multi-agent and worktrees unchanged.

## 10. Acceptance / Definition of Done
1. Zed can launch SuperAgent as a custom ACP agent under Bun with no extra CLI/TUI window and no protocol noise.
2. A prompt yields streamed text, real tool call statuses and a correct terminal outcome.
3. File-changing tools require consent unless a *separate, explicit, audited* permission policy authorizes them; workspace rules remain enforced regardless.
4. Cancelling a turn interrupts model/tools where supported and does not terminate unrelated SuperAgent processes.
5. Multiple sessions remain isolated by client connection, workspace and identity; no cross-session event leakage.
6. Any capability shown in `initialize` is actually implemented and covered by tests.
7. No regression to existing CLI, MCP, T-Line or rolling-restart services.
8. Unit/integration/negative/E2E test evidence plus README and security notes are committed before declaring production-ready.

## 11. Known blockers and risks
- STDOUT pollution from importing global CLI/TUI modules: isolate the ACP entrypoint, add strict smoke.
- Agent permission callback is simpler than ACP permission options; create a policy mapping, not a blanket approval.
- Existing assistant detached tasks do not support generic write-enabled workers or restart adoption; avoid using them as a shortcut.
- Core rolling restart currently does not migrate in-memory ACP processes; scope this separately.
- Zed expects an agent subprocess; this is **not** a shared remote multi-agent service by itself.
- Windows path/drive/junction trust and ambient YOLO must be explicit and fail-closed.
- ACP v2 changes authentication/session lifetime/tool APIs; keep protocol versions isolated.

## 12. Suggested implementation sequence
0. Design types + pin ACP SDK + add red/failing protocol fixtures.
1. Dedicated Bun ACP CLI process, clean stdout, initialize/new/prompt.
2. Event mapping, permission bridge, cancellation and workspace safety.
3. Session policy/concurrency/capability gating plus targeted tests.
4. Zed real E2E + acceptance report + docs.
5. P1 mode/history/worktree/recovery improvements and later P2 client interoperability.

## References
- ACP v1 overview: https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx
- TypeScript SDK: https://github.com/agentclientprotocol/typescript-sdk
- v2 migration / draft warning: https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/migration.mdx
- Zed custom external agents: https://zed.dev/docs/ai/external-agents
