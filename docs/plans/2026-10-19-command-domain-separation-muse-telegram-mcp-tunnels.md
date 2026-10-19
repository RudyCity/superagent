# Command-Domain Separation Plan: Muse, Telegram, MCP, and Tunnels

Date: 2026-10-19
Status: Implemented in working tree — focused build/tests pass; live provider connectivity not verified
Scope: Slash commands, CLI command help, autocomplete/suggestions, help output, tunnel ownership, tests, and documentation

## Objective

Separate the responsibilities of Muse, Telegram, MCP, and tunnel providers so a command only manages the subsystem named by its root. A command should manage only the subsystem named by its root, while shared transport code may be reused behind domain-specific handlers.

## Implementation Progress (2026-10-19)

Implemented in the working tree:
- Added a command-domain catalog for Muse-only, Telegram, MCP-provider, and REST/SSE tunnel suggestions, plus explicit Cloudflare/OpenAI MCP provider metadata.
- Added `/telegram` for Telegram status/doctor/send/config/fallback. Direct message actions only send to Telegram; they no longer steer an active Muse session as a side effect.
- Added `/server tunnel` for REST/SSE exposure. Muse tunnel/watch handlers redirect or reject REST/SSE and Telegram-fallback flags.
- Made `/muse tunnel` list/status/stop-all and CLI help/status operate on Muse WebSocket tunnel records only; stopping Muse tunnels no longer invokes global MCP stop.
- Moved MCP provider discovery to `/mcp tunnel providers` and `superagent mcp tunnel providers`. Start rejects unknown provider values; doctor is provider-specific; restart preserves the active provider and available provider-specific settings when not explicitly overridden.
- Split Muse status/doctor/config/help from Telegram credential/API diagnostics. Telegram credentials are managed using `/telegram config`; legacy Muse message/config aliases emit migration guidance.
- Updated global help and contextual autocomplete, including deprecation guidance for mixed-domain legacy commands; added regression tests for domain isolation.
- Preserved the existing Cloudflare and OpenAI tunnel provider implementations and their unrelated local changes.

Validation:
- `bun run build` — passed.
- Focused regression suite — 12 test files, 175 tests passed.
- `git diff --check` — passed.
- No live OpenAI Secure MCP Tunnel connection was attempted because the local runtime does not have `CONTROL_PLANE_API_KEY` set. Mock tests do not establish live provider connectivity.

Remaining follow-up:
- Perform a live safe MCP request through the configured OpenAI tunnel when a runtime key with Tunnels Read + Use and an actual tunnel ID are available.
- Continue consolidating slash/CLI MCP argument parsing into one service if a broader command-service refactor is desired; domain routing and provider lifecycle commands are separated now, but the slash and CLI handlers still contain some duplicated parsing/formatting logic.

## Current-Code Audit

### Confirmed mixing points

1. `src/core/commands/museCommand.ts`
   - `/muse status` inspects Muse transport, Cloudflare tunnel ports, and a tunnel list that may include unrelated tunnel types.
   - Its help includes both Muse tunnel actions and MCP tunnel flags.
   - `/muse msg|send|message|tg|chat|say` sends to Telegram and may also send to the active Muse brain or fall back to WebSocket.
   - `/tunnel` and `/tunnels` are registered as aliases that forward into `/muse tunnel`.

2. `src/core/commands/museTunnelSubcommand.ts`
   - Handles several unrelated lifecycles: Muse WebSocket tunnel, SuperAgent REST/SSE HTTPS tunnel (`--https`, port 7888), MCP tunnel (`--mcp`), OpenAI provider selection, Telegram fallback, Muse chat, and generic setup/help.
   - Start/stop/restart/status branches must interpret flags to decide which subsystem they are operating on. This makes incorrect routing and confusing recovery instructions more likely.

3. `src/core/commands/mcpCommand.ts` and `src/core/commands/mcpCliHandler.ts`
   - MCP tunnel actions already exist under `/mcp tunnel` and `superagent mcp tunnel`.
   - Slash-command and CLI logic duplicate parsing for provider, tunnel ID, API key, profile, port, start/stop/list/doctor, and output formatting. These can drift.

4. `src/core/commands/coreCommands.ts`
   - Main help describes `/muse tunnel` and root `/tunnel` with `--mcp`, `--provider cloudflare|openai`, and `--tunnel-id`.
   - `/mcp` help describes tunnel actions but does not present MCP provider management as the sole home for those options.

5. `src/utils/dashboardSuggestions.ts`
   - `BUILTIN_DESCRIPTIONS` and `getTunnelSubSuggestions()` repeat many command/flag definitions.
   - Suggestions for `/muse tunnel` and `/tunnel` offer `--mcp`, OpenAI provider selection, MCP auth, MCP port, and OpenAI tunnel IDs.
   - Muse suggestions mix Telegram transport configuration and tunnel operations. Help and autocomplete therefore reinforce the same cross-domain design.

6. Supporting areas
   - `src/core/commands/museDoctorSubcommand.ts` diagnoses both Cloudflare/WebSocket and Telegram depending on Muse's configured transport.
   - `src/core/commands/museConfigSubcommand.ts` currently stores Muse WebSocket settings together with Telegram bot credentials/group identifiers.
   - `src/components/tunnel-menu-dialog.tsx` and the ESC tunnel-menu flow are generic and may need to identify which tunnel subsystem is active before showing stop actions.
   - Existing relevant tests include `museMessageCommand.test.ts`, `museTelegramRealtime.test.ts`, `museWebSocketTransport.test.ts`, `slashCommands.test.ts`, `slashCommandsGap.test.ts`, `tunnelEscapeMenu.test.ts`, `mcpTunnelLifecycle.test.ts`, `mcpTunnelOpenAiIntegration.test.ts`, and `openaiTunnelClient.test.ts`.

## Target Domain Boundaries

### 1. Muse domain — `/muse`

Owns remote Muse task coordination and Muse session/watch behavior only:
- Run/delegate a task, steer, cancel, reset session, watch workspaces, inspect Muse status, connect, and run Muse-specific doctor.
- `/muse tunnel` exclusively manages the Cloudflare-backed Muse WebSocket endpoint and its watcher/tunnel lifecycle.
- Muse tunnel supports Muse-only actions: `list`, `start`, `stop`, `restart`, `status`, `doctor`, and `prompt`/connection details.
- Do not route `--mcp`, `--mcp-port`, `--mcp-auth`, `--allow-dangerous`, `--provider openai`, `--tunnel-id`, or `--control-plane-key` through Muse tunnel commands.
- `/muse status` reports Muse state and its own transport only. It can link/refer to `/telegram status` or `/mcp tunnel status`, but must not claim their health as Muse health.

### 2. Telegram domain — new top-level `/telegram`

Owns direct Telegram bot/group integration used by Muse, without owning the Muse agent task runner and without managing tunnels:
- `/telegram status`
- `/telegram doctor` or `/telegram test`
- `/telegram send <message>`
- `/telegram config` and `/telegram config <key> <value>` for bot token, group ID, Muse bot ID, privacy/connection settings, and Telegram-specific options
- `/telegram fallback status|start|stop` if the current fallback watcher continues to be supported as a separately manageable service

Rules:
- Telegram diagnostics must test Telegram configuration/API, not report OpenAI or Cloudflare tunnel health.
- Telegram messaging must be explicit: `/telegram send` means send to Telegram. It must not silently also steer an active Muse WebSocket brain.
- Muse's watch system may still select Telegram as a transport/adapter (for example `/muse watch --telegram`), but that is a transport choice; it must not cause tunnel-management commands to appear under Telegram.
- Keep `/gateway` distinct: it is the broader omnichannel gateway (Telegram/Discord/Slack), while `/telegram` is the existing direct Telegram/Muse bot integration.

### 3. MCP domain — `/mcp`

Owns external MCP servers, SuperAgent's MCP server, and all MCP exposure/tunnel providers:
- Preserve `/mcp list|add|add-http|remove|reload`.
- Own `/mcp tunnel providers|start|stop|restart|list|status|doctor|guide`.
- Provider selection, tunnel IDs, runtime credentials, MCP ports, MCP auth, dangerous-tool mode, MCP tunnel state, and provider-specific diagnostics belong only here.
- Keep `/mcp tunnel start --provider cloudflare` for Cloudflare Quick Tunnel and `/mcp tunnel start --provider openai --tunnel-id <id>` for OpenAI Secure MCP Tunnel.
- Add a provider registry/capability description so adding another tunnel provider later does not require expanding Muse's command parser.
- Distinguish tunnel provider state from MCP server state: local MCP server can be alive while its tunnel is down; OpenAI tunnel uses a tunnel ID/control-plane connection rather than a generic public URL.
- The slash command and CLI should share parsing, validation, provider selection, output formatting, and lifecycle logic.

### 4. SuperAgent REST/SSE exposure — separate from Muse and MCP

The current `/muse tunnel start --https` path exposes the SuperAgent REST/SSE HTTP server (port 7888), which is neither the Muse WebSocket tunnel nor the MCP HTTP server. During implementation, move it to a clearly named domain such as `/server tunnel` (preferred) or another explicit SuperAgent HTTP exposure command. Do not leave this behavior hidden under `/muse tunnel` or `/mcp tunnel`.

The final implementation must choose one canonical root and document it consistently. The previous root `/tunnel` must not remain a generic alias capable of managing multiple unrelated services.

## Proposed Command UX

Canonical slash commands:

| Domain | Command | Responsibility |
|---|---|---|
| Muse | `/muse status` | Muse task/transport/watch status only |
| Muse | `/muse watch [start|stop|status|add|remove]` | Muse watch lifecycle |
| Muse | `/muse tunnel start|stop|restart|list|status|doctor|prompt` | Muse WebSocket/Cloudflare tunnel only |
| Telegram | `/telegram status|doctor|send|config|fallback` | Direct Telegram integration and fallback watcher |
| MCP | `/mcp list|add|add-http|remove|reload` | MCP client/server configuration |
| MCP | `/mcp tunnel providers` | List providers and supported capabilities |
| MCP | `/mcp tunnel start --provider <provider> [provider options]` | Start MCP server through chosen provider |
| MCP | `/mcp tunnel stop|restart|list|status|doctor` | Operate MCP tunnel(s) only |
| SuperAgent HTTP | `/server tunnel start|stop|status|doctor` | Expose/inspect REST/SSE server separately |

CLI canonical forms:
- `superagent mcp tunnel providers`
- `superagent mcp tunnel start --provider cloudflare`
- `superagent mcp tunnel start --provider openai --tunnel-id <id>`
- `superagent mcp tunnel doctor --provider openai --profile <profile>`
- Reuse the existing official `tunnel-client` diagnostics for OpenAI; Cloudflare checks must not invoke OpenAI `tunnel-client doctor`.

The provider default must be explicit in help and output. Do not silently interpret `--provider <unknown>` as Cloudflare; reject it and list supported providers.

## Suggestions and Help — Single Source of Truth

Create a declarative command catalog (e.g. `src/core/commands/commandCatalog.ts`) that describes each canonical command, subcommand, supported arguments/options, short description, examples, and deprecation/alias metadata.

Use this catalog as the source for:
1. Slash-command autocomplete in `src/utils/dashboardSuggestions.ts`.
2. Suggestion descriptions shown in the interactive dashboard.
3. Main `/help` output in `src/core/commands/coreCommands.ts`.
4. Per-domain help for `/muse help`, `/telegram help`, and `/mcp help`.
5. `superagent mcp --help` / tunnel CLI usage, where feasible.
6. Command documentation examples / generated reference docs.

Avoid maintaining three independent lists in the parser, help output, and suggestion descriptions. If full generation is too large for one phase, at minimum share one command metadata module and migrate all of these consumers to it over staged changes.

Autocomplete acceptance rules:
- Typing `/muse tunnel` must suggest Muse-only tunnel actions; it must not suggest `--mcp`, `--provider openai`, `--tunnel-id`, `--mcp-auth`, or `--mcp-port`.
- Typing `/telegram` suggests Telegram actions only; no tunnel/provider command appears.
- Typing `/mcp tunnel` suggests MCP tunnel actions and provider choices.
- OpenAI-specific options appear only after selecting the OpenAI provider.
- Cloudflare-specific options appear only in the relevant Cloudflare/MCP context.
- `/server tunnel` suggestions cover REST/SSE exposure only.
- Suggestions should be generated from metadata and filtered by the current argument context, rather than hard-coded as near-duplicate strings in multiple locations.

## Compatibility and Migration Policy

Avoid breaking existing user workflows without warning.

1. Add canonical commands first: `/telegram`, canonical `/mcp tunnel` provider paths, and the separate SuperAgent HTTP exposure command.
2. For one documented compatibility window, keep old commands as explicit deprecated aliases:
   - `/muse msg|send|message|tg` redirects to `/telegram send` or emits a clear deprecation notice; it must no longer dual-send into a Muse brain implicitly.
   - `/muse config botToken|groupId|museBotId` directs users to `/telegram config`.
   - `/muse tunnel --mcp` and `/muse tunnel ... --mcp` respond with a migration hint to `/mcp tunnel ...`; if a temporary forwarding path is retained, display a warning and ensure it invokes MCP-only behavior.
   - `/muse tunnel --https` directs to `/server tunnel`.
   - `/tunnel` and `/tunnels` become deprecated Muse-only aliases or a clear migration response; they must not dispatch based on cross-domain flags.
3. Make stop/restart ownership explicit. Stopping a Muse tunnel must not stop MCP or REST/SSE; stopping an MCP tunnel must not stop Muse or Telegram.
4. Remove deprecated flags from canonical help/suggestions immediately, even while a compatibility handler is temporarily retained.
5. Document the deprecation policy and exact replacement commands in the changelog/readme.

## Proposed Module Boundaries

Refactor the current large mixed handler into focused command/domain modules:
- Muse: `museCommand.ts`, `museWatchSubcommand.ts`, `museTunnelSubcommand.ts` (Muse-only), and Muse session/status helpers.
- Telegram: new `telegramCommand.ts` plus focused status/doctor/config/send/fallback handler(s), reusing the current `MuseClient` and watcher transport primitives instead of duplicating them.
- MCP: `mcpCommand.ts`, shared `mcpTunnelCommandService.ts` or equivalent for both slash command and CLI, plus provider adapters for Cloudflare/OpenAI.
- SuperAgent HTTP tunnel: separate command handler for port 7888 / REST/SSE lifecycle.
- Command metadata/help/suggestions: common declarative catalog consumed by UI and command help.

This is separation of command ownership and orchestration boundaries, not a rewrite of the underlying network transports. Reuse existing tested low-level clients where possible.

## Implementation Phases

### Phase 0 — Baseline and safety
- Capture `git status` and current behavior before edits.
- Preserve pre-existing edits in `src/core/mcp/openaiTunnelClient.ts`, `src/core/mcp/mcpTunnel.ts`, `src/core/commands/museTunnelSubcommand.ts`, existing tests, `task.md`, and unrelated untracked plan/review docs.
- Add a command ownership map and baseline test list.
- Do not combine this refactor with unrelated memory, selfdev, or tunnel-client hardening work.

### Phase 1 — Establish the canonical command catalog
- Define command trees and metadata for Muse, Telegram, MCP, and SuperAgent HTTP.
- Mark legacy commands/flags and aliases.
- Add catalog tests: unique canonical roots, no cross-domain option leakage, all help entries map to supported command descriptors.

### Phase 2 — Split command handlers
- Make `museTunnelSubcommand.ts` Muse-only and remove MCP-specific branches/flags from its canonical parser.
- Add `/telegram` command, move direct Telegram send/config/status/doctor/fallback controls to it.
- Extract the MCP tunnel argument parser/lifecycle output so `/mcp` slash command and `superagent mcp` CLI share implementation.
- Move REST/SSE `--https` tunnel management to `/server tunnel`.
- Maintain transport selection in Muse watch as an explicit adapter choice, but remove provider tunnel lifecycle from Muse commands.

### Phase 3 — Suggestions, help, and error guidance
- Replace duplicated tunnel suggestion arrays with catalog-driven suggestions.
- Update built-in suggestion descriptions, per-command help, global `/help`, CLI `--help`, and examples.
- Add contextual migration/deprecation messages for old aliases/flags.
- Make unknown subcommands list only actions valid within the active domain.

### Phase 4 — Status, diagnostics, and operator UX
- Ensure each status/doctor only reports the owning domain.
- Add aggregate `/services status` (optional) only if needed for a cross-domain overview; it must be read-only and clearly separate Muse, Telegram, MCP/provider, and REST/SSE sections.
- Update the ESC tunnel menu to identify tunnel owner/domain; never offer a generic “stop all tunnels” action that crosses domains without explicit confirmation and scope.
- Make provider availability and status honest: process-running, healthy, ready, and connected are distinct states.

### Phase 5 — Tests, docs, and release
- Update README/help examples, changelog, command reference, and tests.
- Run focused tests, build, then broader relevant unit suite.
- Use a live OpenAI Secure MCP Tunnel test only when a configured tunnel ID and runtime key with the required permissions are available. Tests using mocks must not be represented as proof of a live OpenAI control-plane connection.

## Required Tests / Acceptance Criteria

### Command separation
- `/muse tunnel start` affects only Muse WebSocket tunnel/watcher.
- `/muse tunnel` rejects or clearly redirects `--mcp`, provider, MCP auth, MCP port, and OpenAI tunnel ID options.
- `/telegram send` sends only to Telegram and does not implicitly steer Muse brain sessions.
- `/telegram doctor` reports Telegram checks only.
- `/mcp tunnel start --provider cloudflare` only creates/uses the MCP tunnel.
- `/mcp tunnel start --provider openai --tunnel-id <id>` only invokes OpenAI Secure MCP Tunnel.
- `/server tunnel` controls REST/SSE server exposure, not Muse or MCP.
- Stop/restart on each root leaves all other domains untouched.
- Unknown provider/action errors are specific and show supported options.

### Suggestions/help
- No MCP/provider options are suggested under `/muse tunnel`.
- Telegram suggestions contain no Cloudflare/OpenAI tunnel operations.
- MCP suggestions include provider listing and provider-scoped actions.
- Main help and each domain's help match the catalog.
- Legacy aliases show clear migration guidance.
- Command descriptions and suggestion metadata are not duplicated with contradictory definitions.

### Regression suites
Start with:
- `tests/slashCommands.test.ts`
- `tests/slashCommandsGap.test.ts`
- `tests/museMessageCommand.test.ts`
- `tests/museTelegramRealtime.test.ts`
- `tests/museWebSocketTransport.test.ts`
- `tests/museMultiProjectWatch.test.ts`
- `tests/tunnelEscapeMenu.test.ts`
- `tests/mcpTunnelLifecycle.test.ts`
- `tests/mcpTunnelOpenAiIntegration.test.ts`
- `tests/openaiTunnelClient.test.ts`
- `tests/cloudflareTunnel.test.ts`
- New tests for catalog generation, autocomplete isolation, `/telegram` routing, CLI/slash MCP parity, and compatibility behavior.

Validation:
- TypeScript build passes.
- Focused tests pass before broad tests.
- `git diff --check` passes.
- No unrelated changes are staged, committed, reverted, or cleaned up.
- Real tunnel connectivity is verified separately from mocks.
