<div align="center">

# 🚀 Superagent

**A terminal-native general-purpose AI assistant for research, writing, planning, creative work, automation, and coding.**

[![Version](https://img.shields.io/github/v/release/RudyCity/superagent?style=flat-square&color=8A2BE2)](https://github.com/RudyCity/superagent/releases)
[![License](https://img.shields.io/github/license/RudyCity/superagent?style=flat-square&color=blue)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh)
[![t-line](https://img.shields.io/badge/Desktop_App-t--line-00D1B2?style=flat-square)](https://github.com/RudyCity/t-line)

<br />

![Superagent Terminal UI](assets/Video_SuperAgent.gif)

</div>

---

## ⚡ Overview

**Superagent** is a terminal-native general-purpose AI assistant and autonomous operator—not a programmer by default. It helps with questions, research, writing, planning, documents, browsing and workflows, and switches to specialized coding tools and agents when a task actually requires development.

Superagent also pairs natively with **[t-line](https://github.com/RudyCity/t-line)**, its official desktop client.

---

### Chrome CDP Multi-Agent Gateway

SuperAgent CLI and MCP can coordinate multiple Bun agents across Chrome tabs with an atomic cross-process queue, secret session capabilities, read/write ownership checks, and session recovery. Use `superagent_chrome_cdp` with `claim_target`, then send the returned `sessionToken`, `agentId`, and `targetId` on every CDP/vision operation. Check `coordinator_status` for active sessions and queue pressure, and `release_target` when finished. The Chrome Extension bridge intentionally blocks actions while a CDP claim is active; separate profiles are required for separate browser logins.

Complete workflow and limitations: [Multi-agent Chrome CDP sessions](docs/plans/2026-10-22-multi-agent-chrome-cdp-sessions.md).

## ✨ Key Features

- **🎯 General-Purpose Assistant Mode (Primary)**: Natural conversation and content creation, task-aware tool selection, direct action on authorized workflows, and specialized software-engineering execution only when needed.
- **⚡ Instant Startup & System Cache**: Parallelized zero-wait dependency checks, decoupled background neural classifier loading, persistent 24-hour cache, and instant `-q` / `--quick` fast-path (< 200ms).
- **📡 Omnichannel Messaging Gateway**: Bidirectional messaging integration supporting Telegram, Discord, Slack, and generic webhooks with session mapping and automated message chunking.
- **⏰ Autonomous Headless Daemon & Cron Scheduler**: Background execution daemon with standard 5-field cron parsing (`minute hour dom month dow`), overlap protection, concurrency limits, and CLI management.
- **🧩 Autonomous Skill Synthesizer**: Extracts multi-step tool workflows, command patterns, and error recoveries from execution trajectories into reusable `SKILL.md` documents.
- **🖥️ Native Desktop Integration**: Automatic connection with [t-line](https://github.com/RudyCity/t-line) desktop GUI app without manual configuration.
- **🧠 Smart Context Management**: Automatic token tracking, LLM summarization, strategy-based pruning, and message pinning.
- **🛡️ Local Git Checkpoints**: Automatic branch checkpoints and safety rollbacks during active sessions.
- **🛠️ Integrated Tooling**: Built-in file search, regex ripgrep, background command runners, terminal presets, system-level screenshots, and Playwright web page screenshots.
- **⚙️ Batch-First Bounded Execution**: File-read batches use isolated Node OS worker processes (up to four), while local, SSH, and MCP batch I/O use bounded concurrency and ordered results. Check worker counters with MCP tool `superagent_process_pool_status`; see the [multi-process runtime plan](docs/plans/2026-10-14-multiprocess-batch-runtime-plan.md) for current scope and remaining Agent IPC work.
- **🌐 Remote SSH Workspaces**: Secure connection to remote hosts with active boundary protection, interactive path expansion, local-to-remote file transfer, and workspace-based session continuation.
- **🛰️ Remote AI Agent Coordination (Muse)**: Coordinate with a remote AI brain over Cloudflare Tunnel + WebSocket or Telegram bus, delegating high-level reasoning to Muse while Superagent executes batched tools locally with multi-project watch mode and multi-tunnel isolation.
- **🔌 MCP via Tunnel & OpenAI Secure MCP (v1.14.1)**: Expose Superagent tools through Streamable HTTP with dual tunnel provider backends: Cloudflare quick tunnels (Zero Trust) and OpenAI Secure MCP Tunnels (official `tunnel-client` for ChatGPT Connectors & OpenAI Responses API). Includes safe-tool allowlist, explicit opt-in for dangerous operations, automated preflight diagnostics, and audit logging.
- **🗂️ MCP Independent Multi-Project Management (v1.14.0)**: Operate on multiple unrelated local repositories and standalone SSH projects through one MCP connection; Workspace Chain is optional and only needed for cross-node workflows. Register/list/inspect projects by stable ID, target supported tools with projectId, and grant identity-bound read, write, execute, git, worktree, planning, or chain capabilities. Project grants require Full YOLO locally and do not override protected configuration or path-boundary checks. Standalone SSH supports workspace inspection, command execution, batched file I/O, listing/search, and Git via a separate SSH connection per project; unsupported SSH tools fail closed rather than running locally. See [Independent MCP Projects](docs/mcp/independent-projects.md).
- **🌐 Chrome Process Tools (v1.5.146)**: Built-in tools to list all running Chrome windows across profiles (with per-window tab lists) and close a targeted Chrome profile safely.
- **🤖 3-Tier Multi-Agent Mode *(Experimental)***: Master Agent orchestrating isolated Superagents across parallel Git worktrees (`--multi`).
- **🌐 Extension-Free Chrome Automation (v1.10.0)**: Drive the real Chrome browser directly over the Chrome DevTools Protocol — no extension required (`control_chrome_cdp`: navigate, snapshot/click/type by element index, `wait_for`, screenshot, PDF, cookies). Requires Chrome started with `--remote-debugging-port=9222` (see below).
- **👁️ Vision-Based UI Automation & Set-of-Mark Perception (v1.13.30+)**: `control_chrome_vision` uses a local UI-DETR-1 AI (RF-DETR Medium ~535MB) for Set-of-Mark (SoM) visual perception (`perceive_page`), direct coordinate click/type by visual ID (`click_id`, `type_id`), automated UI layout defect auditing (`audit_layout`), and before/after visual diff validation (`verify_visual_state`). No fragile CSS selectors, shadow-DOM, or canvas barriers.

---

## 🚀 Quick Start

### Installation

Requires **[Bun](https://bun.sh) 1.4.2 or newer**. SuperAgent CLI, API server, MCP, daemon/background workers, build and test orchestration use Bun; Node.js is not required for SuperAgent-owned runtimes. External third-party tools configured by users may have their own runtime requirements.

```bash
# Clone the repository
git clone https://github.com/RudyCity/superagent.git
cd superagent

# Install dependencies & build
bun install --frozen-lockfile
bun run build
bun run runtime:smoke  # isolated Bun CLI, process pool, SQLite and RMemory check

# Register globally (optional)
bun install -g .
```

On Windows, an older npm global installation can leave `superagent` shell/cmd/PowerShell shims that bootstrap `node.exe` even after the package is linked to Bun. Verify and repair only those owned shims with `bun run doctor:launcher` and `bun run repair:launcher`. The repair backs up each original shim as `*.pre-bun.bak`, never stops a live process, and requires reconnecting IDE MCP clients to activate the new Bun-native process. Re-register Antigravity with `bun dist/cli.js mcp register`; verify its configuration points to the absolute `bun.exe` executable. User-selected third-party CLI/MCP tools may still require their own runtimes.

### Usage

```bash
# Start Superagent in interactive mode (instant startup)
superagent

# Fast-path prompt execution (< 200ms launch)
superagent -q "explain quantum computing in simple terms"

# Open Superagent in a specific workspace
superagent -w /path/to/project

# Connect to a remote SSH workspace
superagent -ws user@192.168.1.100:/var/www/app

# Manage autonomous background daemon & cron scheduler
superagent daemon list
superagent daemon add --name nightly --cron "0 2 * * *" --prompt "Clean cache"

# Manage the Muse WebSocket tunnel (Cloudflare)
superagent muse tunnel list              # List Muse WebSocket tunnels only
superagent muse tunnel start             # Start Muse WebSocket tunnel (port 9225)
superagent muse tunnel status             # Check Muse WebSocket tunnel status

# In interactive mode: manage REST/SSE exposure separately
/server tunnel start                     # REST/SSE tunnel (typically port 7888)

# MCP providers are managed independently
superagent mcp tunnel providers
superagent mcp tunnel start --provider cloudflare

# Run a task using the remote AI agent (Muse)
superagent muse status
superagent muse "find and refactor all deprecated functions"

# Launch in Multi-Agent Orchestration mode (Experimental)
superagent --multi
```

---

## 💻 Desktop App Integration (`t-line`)

Superagent connects **automatically** with **[t-line](https://github.com/RudyCity/t-line)**, the desktop version of Superagent. 

No manual server configuration or extra CLI arguments are required—simply launch `t-line` alongside Superagent for a unified desktop experience.

---

## 🌐 Chrome Remote Debugging (Extension-Free)

The `control_chrome_cdp` tool automates your real Chrome browser directly over the Chrome DevTools Protocol — no extension needed.

**One-time setup (Windows):**

1. Close **all** Chrome windows (Chrome is singleton: the debug flag is silently ignored if any window is already running).
2. Double-click `scripts/chrome-debug.bat` — it launches Chrome with `--remote-debugging-port=9222`. If Chrome is still running, it warns you instead of killing anything.
3. Verify: `curl http://127.0.0.1:9222/json/version` should return browser info.

**Notes:**

- The debug port binds to `127.0.0.1` only — it is not reachable from the network.
- For a permanent setup, add `--remote-debugging-port=9222` to your Chrome shortcut (e.g. the taskbar-pinned shortcut).
- The tool fails fast with a clear message if Chrome is not running in debug mode.

---

## 👁️ Vision-Based Chrome Automation & Set-of-Mark (SoM) Perception (UI-DETR-1)

The `control_chrome_vision` tool provides **human-like visual perception and spatial grounding** using a local `racineai/UI-DETR-1` model (~535MB, RF-DETR Medium). It eliminates reliance on fragile CSS selectors, DOM tree dumps, or canvas/shadow-DOM limitations.

**Core Capabilities:**
- **Set-of-Mark (SoM) Perception (`perceive_page`)**: Takes a screenshot, detects UI components, overlays numbered visual badges (`[1]`, `[2]`, `[3]...`) and color-coded bounding boxes, and injects the annotated image directly into multimodal LLMs (Claude 3.5 Sonnet, GPT-4o, Gemini, Qwen2.5-VL).
- **Direct Visual Action (`click_id`, `type_id`)**: Dispatches native CDP mouse/keyboard events directly to the center coordinates of any visual ID (e.g. `click_id(id=3)`), enabling seamless interaction even with Canvas, WebGL, or complex shadow-DOM trees.
- **Visual Layout Auditor (`audit_layout`)**: Automatically inspects the page for UI and accessibility defects:
  - **Overlapping Elements**: Collision detection (>40% overlap) between interactive controls.
  - **Touch Target Defects**: Flags buttons or fields smaller than 24×24px.
  - **Off-Screen Elements**: Identifies elements clipped or rendered outside the active viewport.
  - **Unlabeled Controls**: Highlights interactive controls missing accessibility labels or text.
- **Visual State Verification (`verify_visual_state`)**: Compares screenshots before and after actions, computing pixel difference ratios (`/diff`) to guarantee UI transitions actually occurred on screen.
- **Interactive Extension Sidepanel (`chrome-extension/`)**: Includes an interactive vision canvas where human auditors can click directly on screenshot elements (with auto-scaled coordinates dispatched to the active tab) and filter badges by category (`All`, `Buttons`, `Fields`, `Links`).

**Model Details & Zero-Config Setup:**
- **Model:** `racineai/UI-DETR-1` (~535MB, RF-DETR Medium).
- **Classes:** `button`, `field`, `heading`, `iframe`, `image`, `label`, `link`, `text`.
- **Automatic Caching:** Weights (`model.pth`) are downloaded once on first run and permanently cached in HuggingFace Hub (`~/.cache/huggingface/hub/`).
- **Auto-Daemon:** Superagent **automatically starts** the local UI-DETR-1 service (`scripts/vision_server.py` on port 8095) whenever `control_chrome_vision` is invoked.
- **Port:** Listens on `127.0.0.1:8095` (localhost only).
- **Lightweight Architecture:** OmniParser was removed in favor of this single ~535MB model, reducing memory consumption to ~2.8GB VRAM with 2-3× faster inference.

---

## ⌨️ Command Reference

### Core & Session Commands

| Command | Description |
|---|---|
| `/help` | Display interactive command guide and active shortcuts |
| `/new` | Start a new session (clear history & screen) |
| `/clear` | Clear conversation history |
| `/resume` | Resume a conversation session from history via wizard |
| `/session` | Manage session history: list, export `<id>`, clear --empty |
| `/history` | Manage SQLite history database: stats, export, backup, migrate, tag |
| `/search-history` `/sh` | Search conversation history. Usage: `/sh <query> [--all] [--debug]` |
| `/knowledge` `/k` | Browse & search global pinned knowledge (cross-session) |
| `/pin` | Pin important messages (full content + agent tag) |
| `/checkpoint` | Manage checkpoints to save/restore conversation state |
| `/compact` | Show compaction status / force context compaction |
| `/compaction-history` `/ch` | View compaction audit trail |
| `/goal` | Activate Goal Mode for long-running overnight tasks |
| `/init` | Initialize project (Git setup, agents.md generation, system audit) |
| `/exit` `/quit` | Exit the application |
| `/image` | Attach image from clipboard (`paste`) or file path (`attach <path>`) |

### Configuration & Providers

| Command | Description |
|---|---|
| `/setup` | Run interactive provider & initial setup wizard |
| `/login` | Configure AI provider credentials (e.g. `/login openrouter sk-or-...`) |
| `/model` | Switch model presets or custom tier configurations |
| `/settings` | View current rate limit, concurrency & app settings |
| `/setting-concurrency <0\|1>` | Set LLM concurrency limit |
| `/setting-rpm <number>` | Set rate limit RPM |
| `/setting-capacity <number>` | Set rate limit capacity |
| `/setting-streaming <on\|off>` | Enable or disable streaming |
| `/setting-context-limit <number>` | Set context window limit (0 = auto) |
| `/setting-max-iterations <number>` | Set max agent iterations (0 = unlimited) |
| `/setting-checklist-limit <number>` | Set task checklist visible limit |
| `/setting-history-limit <number>` | Set checklist history visible limit |
| `/setting-procs-limit <number>` | Set processes panel visible limit |
| `/setting-focus` `/focus` | Set reasoning focus depth: off\|low\|medium\|high\|xhigh\|max\|custom |
| `/setting-focus-budget <number>` | Set reasoning focus custom budget tokens |
| `/setting-classifier <on\|off>` | Enable/disable multi-category request classifier |
| `/setting-classifier-threshold <high\|medium\|low>` | Set classifier heuristic confidence threshold |
| `/setting-rmemory` | Configure RMemory: on, off, provider, model, dimensions |

### Agent, Tools & Automation

| Command | Description |
|---|---|
| `/agents` | List active subagents and defined subagent types |
| `/processes` `/procs` | List running background processes |
| `/processes stop [id\|all]` | Stop background processes |
| `/daemon` | Manage autonomous background daemon & cron scheduler (start, stop, status, list, add, remove, run) |
| `/terminal` | Manage & execute terminal presets. Subcommands: `<command>`, `preset <name>`, `bg <cmd>`, `all`, `init`, `stop`, `list` |
| `/skills` | List installed skills or synthesize new ones (`/skills synthesize <title>`) |
| `/install` | Install a skill from skills.sh (e.g. `/install vercel-labs/skills/find-skills`) |
| `/memory` | Manage and inspect RMemory long-term memory: status, sync, search, add, delete, list-scenes, read-scene, read-persona |
| `/mcp` | Manage MCP servers and tunnel providers: `list`, `add`, `remove`, `reload`, `use gateway|full|status`; tunnel actions include `providers`, `config` (OpenAI Tunnel ID/key: `set-id`, `set-key-env`, `set-key`, `status`, `clear-id`, `clear-key`, `clear`), `start`, `stop`, `restart`, `list`, `status`, `doctor` |
| `/macro` | Manage and run browser macro presets: list, run, delete |
| `/muse` | Coordinate Muse tasks and watch sessions; `/muse tunnel` controls Muse WebSocket only |
| `/telegram` | Manage direct Telegram bot/group operations: `status`, `doctor`, `send`, `config`, `fallback` |
| `/server tunnel` | Manage Superagent REST/SSE server exposure independently |
| `/core status` `/core restart` | Inspect or roll an opt-in supervised API core; no MCP/Muse/Telegram shutdown |
| `/tunnel` `/tunnels` | Deprecated Muse-only aliases; use `/mcp tunnel` for MCP or `/server tunnel` for REST/SSE |

### Supervised API core restart (opt-in)

For source changes, a separate supervisor can keep the REST/SSE/WebSocket port and bearer token stable while switching API core worker versions. It never calls stop-all or restarts MCP, Muse, or Telegram services. Existing SSE/WebSocket sockets and background tasks remain with the old worker; new requests go to the new worker only after readiness checks.

Run from the repository: bun src/cli.tsx core start --port 7888, then bun src/cli.tsx core status or bun src/cli.tsx core restart. The equivalent slash commands are /core status and /core restart. Build first when running via dist/cli.js. Starting this mode on a port already occupied by an unsupervised server is intentionally refused.

Phase 2 also pins successful session IDs to their original API workers, including session-bound chat JSON, SSE and upgrade routes after restart. New sessions use the new worker. Existing clients should send their session ID when reconnecting; session data stays inside its original process. This is API-core rolling handover, **not full zero-downtime migration of in-memory sessions or live MCP tool processes**. Old workers remain alive rather than being force-killed; a full transport/session supervisor and verified generation drain are future work. See docs/plans/2026-10-25-superagent-core-rolling-restart.md. Manual isolated smoke: bun scripts/verify-core-supervisor.ts.

Phase 3a: /core rollback (or superagent core rollback) switches new traffic back to a previously retained, health-checked worker. A detected active worker exit triggers attempted automatic rollback, without terminating any tunnel or healthy worker. Restart fails closed at four retained workers: there is **no** unverified cleanup or forced process kill to make room. Monitor with /core status. Verified draining and a persistent transport/session host remain future work.

Phase 3b: /core drain (or superagent core drain) checks retained API workers twice before retirement and blocks when sessions, SSE/WebSocket requests, subprocesses, agents, background/daemon/Muse tasks or the fixed-port vision helper remain. The separate inspection endpoint uses a secret and is never exposed publicly. The action reports blocked/retired generations in /core status. Isolated verification: bun scripts/verify-core-supervisor.ts. Persistent external MCP/Telegram/Muse transport and supervisor crash adoption remain future work.

Phase 3c: superagent core recover --port 7888 restores the opt-in API supervisor after a crash. A protected checkpoint retains session-to-worker ownership and the stable public API token; recovery verifies original worker identities before reattachment and refuses unverified sessions. New API generations can still be rolled. Existing SSE/WebSocket TCP connections must reconnect after supervisor crash; this does NOT migrate agent memory or make MCP/OAuth/Telegram/Muse zero-downtime. Isolated verification: bun scripts/verify-core-supervisor.ts. See docs/plans/2026-10-25-superagent-core-rolling-restart.md.

Phase 4a: opt-in T-Line REST/SSE/WebSocket frontend now runs in its own persistent loopback process, independently of the API core supervisor. Start a supervised core with superagent core start --port 7888, then in another terminal run superagent transport start --port 7891 --core-port 7888. Point T-Line to http://127.0.0.1:7891 and inspect it with superagent transport status --port 7891. The host authenticates supervisor ownership before forwarding bearer credentials, proxies REST/SSE/WS, and remains reachable during core supervisor outage with HTTP 503 until explicit recovery. Existing SSE/WS streams still require reconnect after a supervisor crash. This does not restart or migrate MCP/Muse/Telegram transports. See docs/plans/2026-10-25-superagent-core-rolling-restart.md.

Phase 4b: an independent opt-in channel host can own a Muse WebSocket or Telegram fallback watcher outside the API core process. By default it starts safely with no external channel: superagent channel-host serve --port 7892 --mode idle. Inspect with superagent channel-host status --port 7892 or global /status all. To enable a configured local Muse watcher explicitly, use --mode muse-ws --ws-port 9225; to enable Telegram fallback explicitly on a separate port, use --mode telegram-fallback. Each non-idle mode has exclusive ownership leases, and the read-only loopback health endpoint never exposes credentials. This does NOT automatically migrate existing watchers, attach MCP OAuth tunnels, expose Muse via Cloudflare, persist in-flight agent execution or prove live Telegram connectivity. Never run duplicate Telegram pollers. See docs/plans/2026-10-25-superagent-core-rolling-restart.md.

Phase 4c: authenticated channel-host IPC now exposes only the explicitly supported steer, task and abort operations from the owner process; no new watcher is spawned by the core. A per-host 256-bit token is kept in owner-only local discovery metadata (not health/status), a request ID prevents concurrent duplicate dispatch for 10 minutes, and a single-flight guard rejects overlapping different mutations. Use /muse host status, /muse host steer <text> --port 7892, /muse host task <text> --port 7892 or /muse host abort [reason] --port 7892. Requires an independently running and active Muse or Telegram fallback channel host. Legacy /muse watch and /muse steer remain local. This is dispatch acknowledgment, not proof of remote delivery, and no actual bot/tunnel was contacted during tests. See docs/plans/2026-10-25-superagent-core-rolling-restart.md.

Phase 4m adds *fail-closed integrity enforcement* at side-effect boundaries: managed Muse channel hosts rescan recovery storage before new tool batches, result replay and untouched resume, refusing unsafe operations on damaged or unverified checkpoints while leaving abort available. Sanitized transitions are appended/fsynced to an owner-port-local hash-chained history; view with superagent channel-host alerts --port 7892 [--limit 20]. The ledger is bundled with Phase 4k backups, and a corrupt, full or unwritable ledger blocks sensitive recovery operations. Local status/console notifications are not external push alerts or rollback-proof WORM logging. See docs/plans/2026-10-25-superagent-core-rolling-restart.md.

Phase 4l adds periodic read-only Muse recovery integrity monitoring to independent channel hosts (first scan at start; repeat every 60 seconds; stop on host close). The loopback health status exposes redacted last scan, counts and states not_initialized / healthy / degraded / failed / stale, with no checkpoint contents or secret paths. Inspect using superagent channel-host status --port 7892 or superagent channel-host integrity --port 7892 (live cached verified-owner status, otherwise offline full scan); use verify-store for a direct deep scan. Monitoring does not restart channels, rerun tools, repair storage or send remote alerts. See docs/plans/2026-10-25-superagent-core-rolling-restart.md.

Phase 4k adds a guarded offline, per-port recovery backup/restore workflow including journal, archived replay tombstones, encrypted results, execution intent, and their PRIVATE keys. Inspect with superagent channel-host verify-store --port 7892; create and validate a backup using channel-host backup --destination ABSOLUTE_NEW_DIRECTORY and verify-backup --source ABSOLUTE_BUNDLE_DIRECTORY, then restore ONLY to completely empty same-port owner storage with restore-backup --source ABSOLUTE_BUNDLE_DIRECTORY --confirm-port 7892. An incomplete restore leaves a durable startup-blocking marker. All changes require the exclusive owner lock. Copy backups into an independent encrypted vault and protect against old-snapshot rollback; SHA-256 manifests are not tamper-proof attestation. See docs/plans/2026-10-25-superagent-core-rolling-restart.md.

Phase 4j adds a bounded, SHA-256/HMAC-authenticated tombstone archive for finalized ACKed Muse batches. Use superagent channel-host archive --port 7892 for a read-only preview, then superagent channel-host compact --port 7892 --confirm-port 7892 to archive up to 64 eligible replay tombstones. Only OFFLINE, delivered, ACKed, fully payload-pruned batches qualify; archived batch IDs remain blocked from re-execution after restarts. This is not filesystem-level WORM or an infinite archive, and a lost/tampered segment fails closed. See docs/plans/2026-10-25-superagent-core-rolling-restart.md.

Phase 4i adds explicit ACK-only offline encrypted payload retention while retaining every journal batch ID as a replay-blocking tombstone. Check with superagent channel-host retention --port 7892; prune only an ACKed batch using superagent channel-host prune --port 7892 --batch-id ID --confirm ID (default minimum ACK age: 7 days). A durable release marker makes partial cleanup recoverable after crashes. Never prune unresolved work or a registered live/stale host. Journal tombstone archival, automatic cleanup and mid-LLM resume are not included. See docs/plans/2026-10-25-superagent-core-rolling-restart.md.

Phase 4h adds a read-only recovery orchestrator that cross-checks the batch journal, encrypted execution checkpoints and encrypted result outbox before allowing operator-initiated recovery. Run superagent channel-host recovery --port 7892 [--batch-id ID] to inspect conservative recovery decisions. Inconsistent/orphaned records fail closed. No automatic tool replay or mid-LLM state restoration is claimed. See docs/plans/2026-10-25-superagent-core-rolling-restart.md.

Phase 4g adds encrypted batch execution-intent checkpoints and durable per-call STARTED/FINISHED boundaries in opt-in independent Muse/Telegram channel hosts. Only a batch with ZERO previously started tools can be manually resumed once via /muse host resume-untouched BATCH_ID --port 7892. Any started/uncertain call stays blocked for reconciliation. This does not resume an in-progress LLM or automatically replay tool effects. See docs/plans/2026-10-25-superagent-core-rolling-restart.md.

Phase 4f adds an encrypted, bounded result outbox for opt-in independent Muse/Telegram channel hosts. A successful local transport send is distinct from an authenticated Muse result_ack. To resend ONLY a saved result after reconnect without repeating tools, explicitly invoke /muse host replay-result BATCH_ID --port 7892. Results are encrypted at rest using a private per-port key; do not expose or delete this key, and reconcile uncertain tool effects independently. Full LLM state resume and exactly-once remote processing are not provided. See docs/plans/2026-10-25-superagent-core-rolling-restart.md.

Phase 4d adds conservative durable batch checkpointing to opt-in independent Muse/Telegram watchers. Each batch ID is durably journaled BEFORE executing any tools; result delivery transitions are journaled afterward. On restart the same batch is never replayed automatically, so uncertain tool side effects require manual reconciliation. Inspect with superagent channel-host checkpoint --port 7892 (offline-capable). The journal stores IDs/stages, NOT prompts, secrets, tool arguments or outputs, and this is not full AI state recovery or an exactly-once external transaction. See docs/plans/2026-10-25-superagent-core-rolling-restart.md.

### Hermes-Style Skill Feedback and Guided Revision

An approved/pinned skill run records version-bound outcome metrics. Two consecutive failed daemon runs for the same pinned version can create a **project-scoped, quarantined candidate advisory** in RMemory, linked to the exact run IDs. Negative feedback creates another quarantined advisory linked to a persisted feedback ID. Candidates are excluded from automatic recall until reviewed; failures to reach RMemory do not change the underlying run's outcome.

```bash
superagent skill feedback <name>@<12-char-version> negative --summary "Describe the failure"
superagent skill revise <name>@<12-char-version> --feedback-id <persisted-feedback-id> --workspace ./project
superagent skill evaluate <name>@<new-version> --workspace ./project
superagent skill replay <name>@<new-version> --fixture fixtures/replay.json --workspace ./project
superagent skill promote <name>@<new-version> --workspace ./project
```

The revision command produces an **inactive, immutable review candidate** with the exact parent version/hash and feedback provenance. It preserves the original version and never automatically promotes or edits the active skill. Owner approval remains interactive and mandatory. Live RMemory delivery and full-provider E2E tests are separate release gates.

**OAuth MCP resource protection:** In OAuth mode, MCP resources and prompt templates require a readable scope; live task status, runtime configuration, session history and pinned knowledge additionally require separately consented write+admin scopes. Read-only clients cannot discover or directly fetch those sensitive URIs, including over stateless MCP HTTP. See docs/plans/2026-10-20-superagent-hermes-phase-5-resource-scope-restart-isolation.md.

**Privileged MCP project administration:** OAuth tokens with only mcp:tools:write cannot alter project registry entries or access grants. Those tools additionally require an owner-consented mcp:tools:admin scope; local Full YOLO and project boundaries still apply independently. This is approval of the OAuth grant, not a per-tool interactive approval. See docs/plans/2026-10-20-superagent-hermes-phase-5-privileged-oauth-grants.md.

**OpenAI Secure MCP Tunnel OAuth issuer:** For /mcp tunnel start --provider openai --mcp-auth oauth supply --oauth-public-url https://your-public-host (or OPENAI_MCP_OAUTH_PUBLIC_URL). The HTTPS issuer must genuinely expose OAuth discovery, authorize and token routes externally; the opaque OpenAI tunnel ID is not an OAuth issuer. Startup rejects localhost/HTTP issuers. Cloudflare OAuth uses its own public hostname. See docs/plans/2026-10-20-superagent-hermes-phase-5-public-oauth-issuer-hardening.md.

**OAuth session ownership:** HTTP MCP sessions are bound to the exact OAuth access token credential; a refreshed or separately issued token must initialize a new session. Foreign-session DELETE is denied, revoked tokens fail at the HTTP boundary, and tokens lacking tool scope cannot read or discover tools. Local HTTP PKCE and multi-client verification: docs/plans/2026-10-20-superagent-hermes-phase-5-oauth-http-session-isolation.md.

**MCP OAuth write scope:** Dangerous MCP tool discovery and invocation require a current OAuth mcp:tools:write grant even if local YOLO or --allow-dangerous is enabled. A read-only token cannot be elevated by local tool availability; denial audit omits write payloads. See docs/plans/2026-10-20-superagent-hermes-phase-5-oauth-tool-scope-hardening.md.

**Scoped Muse Watcher task status:** Local /muse watch status displays an in-flight task ID only when the T-Line workspace exactly matches the task workspace. Global remote status (MCP/tunnel) reports task presence without task IDs. No prompt, transcript or permission grant is copied. See docs/plans/2026-10-20-superagent-hermes-phase-5-watcher-task-scope.md.

**Hermes Phase 5 local Muse status:** Local /muse status (T-Line) and superagent muse status (CLI) show a normalized view of an active remote task only for the current workspace. No prompts, secrets or conversation histories are copied; running does not count as verified completion. See docs/plans/2026-10-20-superagent-hermes-phase-5-muse-tline-live-task-status.md.

**Process start identity for CLI recovery:** New CLI Bridge jobs store best-effort owner/child process birth fingerprints. delegate.recovery compares these with current Windows CIM or Linux proc observations to flag potential PID reuse; even a matching start identity does not certify descendants or permit reattach, kill, or lock cleanup. See docs/plans/2026-10-20-superagent-hermes-phase-4-process-start-identity.md.

**Read-only CLI crash diagnostics:** Use cli_bridge action=delegate.recovery with an authorized jobId to inspect last recorded owner/child PID hints and the stored job status. A present PID is not verified owner identity, and missing owners require manual investigation of descendants and output locks; no automatic kill, reattach, or lock cleanup occurs. See docs/plans/2026-10-20-superagent-hermes-phase-4-cli-recovery-diagnostics.md.

**Bounded CLI job checkpoints:** After writing a per-job metadata snapshot, SuperAgent retains 8 committed checkpoints per owned job. Cleanup never touches peer job directories or unknown files and skips pruning if the newest checkpoint cannot be validated. See docs/plans/2026-10-20-superagent-hermes-phase-4-job-shard-retention.md. Global job/log retention and crash recovery remain separate gates.

**Multi-process CLI job history:** Authoritative delegation metadata is stored as immutable per-job snapshots under `cli-bridge/delegations/jobs.d/`; the legacy `jobs.json` is a compatibility cache only. Independent SuperAgent instances sharing a config root no longer overwrite one another's job records. See `docs/plans/2026-10-20-superagent-hermes-phase-4-cli-job-shards.md`.

**Read-only output claim diagnostics:** Use cli_bridge action=delegate.claims with expectedArtifacts to inspect a lock inside the authorized workspace. It never reveals a lock token or removes it; manual recovery requires verifying child processes are stopped.

**CLI output locks across processes:** `delegate.start` with declared `expectedArtifacts` now takes per-output exclusive lockfiles before launching the child. Separate SuperAgent instances on the same host cannot cooperatively claim the same output, even if they use different config directories. Crashed-owner locks are **never reclaimed automatically**: descendant CLI processes may still be running. Operators must first verify all writers have stopped. This does not provide multi-host locks, an OS sandbox or transactional multi-writer job metadata. See `docs/plans/2026-10-20-superagent-hermes-phase-4-cross-process-artifact-claims.md`.

**Hermes CLI completion evidence:** For background `cli_bridge` `delegate.start`, optional `expectedArtifacts: ["path/inside/workspace"]` records bounded SHA-256 file-change evidence in `delegate.get/tail`. Exit code 0 without declared evidence is **unverified**, not a proven completed task; unchanged or missing expected files produce `verification_failed`. Expected output claims cannot overlap in the same running SuperAgent process. See `docs/plans/2026-10-20-superagent-hermes-phase-4-cli-artifact-evidence.md`. This is file-change evidence, not semantic task proof or an OS sandbox.

**CLI Bridge project isolation:** Background delegation jobs and interactive sessions are scoped to the calling workspace. A job/session ID from another project cannot read logs, send messages or cancel processes. Explicit `cwd` may select only an existing child of the current workspace; artifact paths cannot escape it (including symlinks). Select the intended registered workspace explicitly before delegating to another project. This is verified with local test CLIs, not live SSH/provider acceptance. See `docs/plans/2026-10-20-superagent-hermes-phase-4-cli-bridge-workspace-isolation.md`.

### Hermes-Style Multi-Agent Outcome Reporting

Delegated subagent and superagent reports now distinguish declared `completed`, `blocked`, `partial`, `failed`, `cancelled`, and `unverified` outcomes. An agent execution returning does **not** by itself prove that the task passed verification. Background parent notifications label blocked/unverified results separately, and early termination requires a completed declaration **plus** passing tests. Explicit incomplete results cannot silently promote a Superagent to successful completion.

The current Phase 4 work is a bounded reliability increment, not full multi-project release certification. See `docs/plans/2026-10-20-superagent-hermes-phase-4-delegation-outcome-implementation.md`. Cross-project/SSH delegation, provider-backed cancellation and staging remain open acceptance gates.

### Workspace Management

| Command | Description |
|---|---|
| `/workspace` `/w` | Manage local, remote (SSH) workspaces, and workspace chains |
| `/worktrees` `/worktree` | Manage Git worktrees: list, prune, remove |
| `/ssh` | Manage active SSH workspace boundary (only available in SSH mode) |

`/workspace` subcommands:
- `status` — Show current workspace info & SSH remote status
- `add <path\|ssh://...>` — Register a workspace (local path or SSH remote)
- `use <path\|index>` — Switch to a registered workspace

SSH remote format: `ssh://user@host:port/path?key=/path/key.pem`
Declaring extra allowed paths: `ssh://user@host:port/path?key=/path/key.pem&allow=/var/www/html,/etc/nginx`

**SSH workspace example:**

```bash
# Add SSH remote workspace
/workspace add ssh://root@192.168.1.100:22/home/projects/myapp?key=~/.ssh/id_rsa

# Switch to it
/workspace use ssh://root@192.168.1.100:22/home/projects/myapp

# Check remote status
/workspace status
```

`/ssh` subcommands:
- `status` — Show current SSH host, workspace path, and allowed paths
- `expand <path>` — Whitelist an extra absolute path (e.g. `/var/www/html`)
- `allowed` — List all currently whitelisted extra paths

#### 🔒 SSH Workspace Boundary Expansion & Allowed Paths

Superagent enforces strict boundary protection on SSH remote workspaces to prevent unauthorized file read/write operations. You can expand access to additional paths:
- **Automatic Boundary Expansion**: If a tool attempts to access a path outside the remote workspace, Superagent will pop up an interactive confirmation dialog. Once approved, the boundary is dynamically expanded.
- **Allowed Paths via URL**: Specify additional directories during connection using the `?allow=` parameter.
- **Runtime Command**: Whitelist a directory at any time using `/ssh expand <path>`.

#### 📂 Local Session Scratch & File Transfer

When operating in an SSH remote workspace, you can still leverage local workspace operations:
- **Local Routing Bypass**: File reads and writes under the current local session history directory (`~/.superagent-r/history/<mode>/<sessionId>/`) automatically bypass remote SSH routing.
- **File Transfer Tool (`transfer_ssh_file`)**: Use this tool to upload files from your local session scratch directory to the remote workspace, or download results from the remote workspace to the local session scratch directory.

#### 🗂️ Independent MCP Projects (No Chain Required)

One MCP connection can target several local repositories by stable projectId, and can also operate on supported standalone SSH projects. Register projects and inspect them with the project tools, then pass the project ID to each supported workspace-scoped MCP call. A per-call project target does not change the session's default workspace. Project-access tools provide identity-bound capabilities; granting access requires the local operator to enable Full YOLO and expose dangerous tools. Registration alone never grants access; project registry mutations and grant creation require Full YOLO locally.

Standalone SSH projects are not wrapped in one-node Workspace Chains. Supported SSH operations use a connection scoped to that registered project and enforce its remote root for file operations. SSH command execution has the configured remote OS user's privileges; the path root is not a shell sandbox. See [the complete MCP project guide](docs/mcp/independent-projects.md) for registration, grants, tool examples, and SSH limitations.

#### 🔗 Workspace Chaining (Cross-Workspace Development)

Workspace Chaining allows you to link multiple workspaces—both local directories and remote SSH targets—into a single connected topology. This enables the AI agent to understand relationships between your services (e.g. backend api, frontend app, database, worker) and perform cross-workspace operations.

- **Workspace Chains Wizard**: Manage chains interactively by opening the `/workspace` wizard and selecting `🔗 Manage workspace chains...`. You can list, create, edit, add nodes, remove nodes, and delete chains.
- **Node Context Descriptions**: When adding a node to a chain, you can specify a text description (purpose/context) describing what the node represents.
- **Dynamic Context Injection**: The active chain's topology, node roles, paths, and purpose descriptions are dynamically injected into the AI's base prompt.
- **Automatic Workspace Switching**: Switching workspaces automatically switches to the workspace chain associated with the active workspace.
- **Cross-Workspace Execution**: The agent uses `cross_workspace_exec` to run commands, read files, and write code across different local or remote nodes within the chain.

**`/worktrees` subcommands:**
- `list` — Show all Git worktrees
- `prune` — Clean stale worktree metadata
- `remove <path>` — Remove a worktree

### 🛰️ Remote AI Agent Coordination (Muse)

Superagent can pair with an external AI agent (**Muse**) acting as a remote cognitive brain while Superagent provides local file access, command execution, and test running on your workstation. Muse owns task coordination, watch sessions, steering, and its own WebSocket transport. Telegram messaging, MCP tunnels, and REST/SSE server exposure are separate command domains.

**Muse WebSocket tunnel**
- Uses Cloudflare Tunnel for the Muse WSS endpoint (default local WebSocket port 9225).
- Supports multi-project watch sessions and per-session tunnel ports.
- Muse-only lifecycle commands must not stop MCP or REST/SSE services.

```text
/muse <task>
/muse status
/muse watch <dir1> <dir2> --tunnel
/muse tunnel list
/muse tunnel start
/muse tunnel start --port 9226
/muse tunnel status
/muse tunnel stop
/muse tunnel stop all
/muse tunnel doctor
/muse tunnel prompt
```

**Direct Telegram integration**

Use `/telegram` for bot/group configuration and direct messages. A direct Telegram send does not steer an active Muse task.

```text
/telegram status
/telegram doctor
/telegram config
/telegram send <message>
/telegram fallback status
/telegram fallback start
/telegram fallback stop
```

**MCP tunnel providers**

MCP servers and provider-specific tunnels live under `/mcp tunnel` or `superagent mcp tunnel`. Supported providers are Cloudflare Quick Tunnel and OpenAI Secure MCP Tunnel. Use the provider listing before starting a tunnel; OpenAI requires a tunnel ID and valid Control Plane credentials.

```text
/mcp tunnel providers
/mcp tunnel start --provider cloudflare
/mcp tunnel start --provider openai --tunnel-id <id>
/mcp tunnel list
/mcp tunnel status
/mcp tunnel doctor --provider openai
/mcp tunnel restart
/mcp tunnel stop
```

#### Adaptive MCP Tools: discovery, gateway mode and reconnect

SuperAgent supports two external MCP tool-catalog modes. **Gateway** (default) exposes a stable set of four tools for new sessions. **Full** is an explicit compatibility option that exposes the authorized standalone tool list for existing clients. Gateway provides: `superagent_tool_search`, `superagent_tool_describe`, `superagent_tool_execute`, and `superagent_tool_status` (all four endpoints are available in read-only sessions; the execute gateway rechecks permissions for each underlying target). A gateway client searches by keyword or natural-language *intent*, retrieves one tool schema, then invokes the tool through its **original authorization and workspace checks**. Intent ranking is lightweight lexical matching, **not embedding-based semantic search**.

New installations need no setup for Gateway. Choose a mode explicitly with the CLI or interactive TUI:

```bash
superagent mcp use gateway     # Select the default compact discovery mode explicitly
superagent mcp use status      # Check saved setting and environment override
superagent mcp use full        # Opt in to the original/full tool catalog
```

```text
/mcp use gateway
/mcp use status
/mcp use full
```

In the interactive terminal (including T-Line), typing `/mcp use` shows contextual suggestions for `gateway`, `full`, and `status`. Partial inputs such as `/mcp use g` autocomplete via `Tab`; tunnel suggestions remain under `/mcp tunnel`.

If no mode has been saved, Gateway is selected automatically. An existing explicit `full` selection is preserved until changed to Gateway. The selected mode persists in `~/.superagent-r/mcp-tool-exposure.json` (Windows: `%USERPROFILE%\.superagent-r\mcp-tool-exposure.json`), separate from providers and workspaces. Set `SUPERAGENT_MCP_TOOL_EXPOSURE=gateway` or `full` to override the saved setting for the current process. **Restart/reconnect the owning MCP server or tunnel after changing mode**; existing MCP sessions are not switched or terminated automatically. Other processes can continue in their existing mode until restarted.

Gateway calls in authorized sessions:

```json
{"name":"superagent_tool_search","arguments":{"intent":"audit checkout and commit","limit":8}}
{"name":"superagent_tool_describe","arguments":{"name":"superagent_get_workspace"}}
{"name":"superagent_tool_execute","arguments":{"name":"superagent_get_workspace","arguments":{}}}
{"name":"superagent_tool_status","arguments":{}}
```

**Security:** Search and describe show only currently authorized capabilities; revoked OAuth scopes, tool allowlists, disabled tools, project permissions, and Scoped/Full YOLO boundaries are enforced on execution too. Read-only OAuth credentials can use `superagent_tool_execute` for safe/read-only targets. Dangerous targets still require the original write scope, tool allowlist, and project/YOLO boundaries; enabling Gateway never grants additional permissions. The gateway execute endpoint advertises potentially mutating annotations to clients because it can dispatch write-authorized targets.

**Dynamic outbound MCP clients:** `manage_mcp({action:"refresh",name:"server"})` refreshes just one catalog; `manage_mcp({action:"reconnect",name:"server"})` reconnects only that server; `manage_mcp({action:"stats",name:"server"})` returns bounded call counts, failures, and durations without saving arguments or response payloads. Disconnected servers revoke stale tool handles, with bounded automatic reconnection (OAuth automatic reconnect requires explicit opt-in). These are **internal agent tools**, not the same as the four externally exposed gateway methods.

See [Adaptive MCP Tool Runtime implementation details](docs/plans/2026-10-22-adaptive-mcp-tool-runtime-implementation.md) for limitations, tests, and the next semantic-search phase.

**Superagent REST/SSE exposure**

REST/SSE exposure is separate from Muse WSS and MCP. It is managed through `/server tunnel`, typically on local port 7888.

```text
/server tunnel list
/server tunnel start
/server tunnel start --port 8080
/server tunnel status
/server tunnel doctor
/server tunnel stop
```

**Aggregate service status and shutdown**

Use one command to inspect all supported service domains, or shut down SuperAgent-managed connections and tunnel exposures:

```text
/status all
/stop all
```

- `/status all` is read-only. It checks the Telegram Bot API and local fallback watcher, configured MCP client servers, MCP tunnel servers, REST/SSE tunnel, and Muse WebSocket tunnels.
- `/stop all` disconnects configured MCP client servers, stops locally owned MCP tunnel servers, stops known Muse WebSocket and REST/SSE tunnel exposures, and stops local Muse/Telegram fallback watchers. Saved configuration and credentials are preserved.
- The Telegram Bot API is remote and cannot be stopped by SuperAgent. MCP tunnels owned by another SuperAgent process are reported as skipped; tunnels with an unknown service kind are left untouched.
- Run `/status all` again after shutdown to verify what remains active.

**CLI note:** use `superagent mcp tunnel ...` for MCP provider operations and the dedicated `/server tunnel` command in the TUI for REST/SSE. Legacy `/tunnel` and `/tunnels` aliases are Muse-only compatibility shortcuts; do not use them to manage MCP or REST/SSE tunnels.

**REST/SSE tunnel security notes:**
- **Bearer token enforcement**: Requests to the public REST/SSE endpoint require `Authorization: Bearer <token>`.
- **CORS protection**: CORS origins are validated by the server security layer.
- **Separate lifecycle**: REST/SSE exposure is managed by `/server tunnel`, not `/muse tunnel` or `/mcp tunnel`.

**Starting Watch Mode with Tunnel:**

```bash
# Watch multiple workspaces and expose via Cloudflare Tunnel:
/muse watch ./frontend ./backend --tunnel

# CLI equivalent:
superagent muse watch ./frontend ./backend --tunnel
```

**Telegram Configuration:**

```text
# Configure direct Telegram bot/group settings
/telegram config botToken <bot-token>
/telegram config groupId <group-id>
/telegram config museBotId <bot-user-id>

# Inspect Telegram connectivity independently
/telegram status
/telegram doctor

# Muse task and WebSocket status remains separate
/muse status
```

**Running Tasks:**

```bash
# In interactive mode
/muse refactor the authentication middleware to use JWT

# From the command line
superagent muse "find all unhandled promise rejections in src"
```

#### Connecting Grok.com (Custom MCP)

Grok.com supports custom remote MCP connectors via public HTTPS Streamable HTTP. Start Cloudflare with OAuth and safe tools:

    superagent mcp tunnel start --provider cloudflare --mcp-auth oauth
    superagent mcp tunnel status
    bun scripts/grok-mcp-doctor.ts https://YOUR-TUNNEL.trycloudflare.com/mcp

Open https://grok.com/connectors and choose New Connector > Custom. Enter the current public HTTPS /mcp URL and complete OAuth with the one-time bootstrap code from SuperAgent. Test a read-only tool. The doctor checks public OAuth discovery and the HEAD authentication challenge, not an authenticated Grok tool call. Grok Build CLI:

    grok mcp add --transport http superagent https://YOUR-TUNNEL.trycloudflare.com/mcp
    grok mcp doctor superagent

Quick tunnel URLs change after restart; reconfigure the connector. Do not share OAuth tokens or bootstrap codes. See [Grok compatibility](docs/plans/2026-10-22-grok-mcp-compatibility.md).

#### 🤖 Connecting ChatGPT as Custom MCP Client (OAuth 2.1)

1. Launch the MCP tunnel in OAuth mode using the dedicated MCP command:
```bash
superagent mcp tunnel start --provider cloudflare --mcp-auth oauth
# or with write/exec permissions:
superagent mcp tunnel start --provider cloudflare --mcp-auth oauth --allow-dangerous
```
2. In ChatGPT, open Settings > Connected Apps / Custom MCP, and choose **Add custom MCP server**.
3. Fill in:
   - **Connection**: Server URL
   - **Server URL**: The public endpoint URL (e.g. `https://<subdomain>.trycloudflare.com/mcp`)
   - **Authentication**: OAuth
4. Click **Advanced OAuth settings** to resolve *"Enter an OAuth client ID"*:
   - **Registration method**: User-Defined OAuth Client
   - **OAuth client ID**: Enter any name (e.g. `chatgpt` or `superagent`). Superagent dynamically registers any client identifier.
   - **OAuth client secret**: Leave blank (empty). PKCE S256 requires no secret.
   - **Token endpoint auth method**: `none`.
5. Return to the main dialog and click **Create as a plugin**.
6. When ChatGPT opens the authorization consent page in your browser, enter the one-time **bootstrap approval code** printed in your terminal and click **Approve**.

For the complete end-to-end setup guide, Zero Trust configuration, multi-project workflows, and the Muse system prompt, see **[docs/remote-agent-setup.md](docs/remote-agent-setup.md)**.

#### 🔐 OpenAI Secure MCP Tunnel (Responses API & ChatGPT Connectors)

Superagent includes native integration with OpenAI Secure MCP Tunnels via the official `tunnel-client` binary, allowing you to expose your local Superagent MCP server directly to the OpenAI Responses API, ChatGPT Connectors, and OpenAI Codex over an authenticated reverse proxy.

1. **Prerequisites & Installation**:
   - Install the official OpenAI `tunnel-client` binary:
     ```bash
     bun add -g @openai/tunnel-client
     # or download binary from https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
     ```
   - **OpenAI Control Plane API Key**:
     OpenAI Secure MCP Tunnels connect directly and privately to OpenAI's control plane (`api.openai.com`). An API key with *Tunnels Read + Use* permission (or your organization/project API key) is required to authenticate your machine and prove ownership of the `tunnel_id`, preventing unauthorized access.
     The tunnel integration accepts an explicit `--api-key <key>` (alias: `--control-plane-key <key>`) or reads `CONTROL_PLANE_API_KEY` from the environment. It deliberately does not fall back to the model provider's `OPENAI_API_KEY`.

     **Important:** `/login add openai <key>` configures the model provider; it is not a persistent setting for the Secure MCP Tunnel control-plane credential. Avoid passing a real secret directly in a command during routine use because command input may be retained in history or logs.

     **Recommended: save tunnel configuration in Superagent**:
     Configure the Tunnel ID once and save the runtime key encrypted at rest using the existing Superagent secret store. This configuration is separate from model-provider credentials.

     First, make CONTROL_PLANE_API_KEY available to the Superagent process (PowerShell/Bash examples below), then run these commands in the interactive terminal:

     ```text
     /mcp tunnel config set-id <YOUR_TUNNEL_ID>
     /mcp tunnel config set-key-env
     /mcp tunnel config status
     /mcp tunnel start --provider openai
     ```

     CLI equivalents:
     ```bash
     superagent mcp tunnel config set-id <YOUR_TUNNEL_ID>
     superagent mcp tunnel config set-key-env
     superagent mcp tunnel config status
     superagent mcp tunnel start --provider openai
     ```

     `set-key-env` copies CONTROL_PLANE_API_KEY into encrypted local storage without echoing it. `set-key <key>` is also available, but can expose the secret in shell history; prefer `set-key-env`. Environment values take precedence over saved values. `clear-id`, `clear-key`, and `clear` remove saved config only; they do not unset environment variables.

     PowerShell (set it before starting Superagent from the same terminal):
     ```powershell
     $env:CONTROL_PLANE_API_KEY = 'your-control-plane-api-key'
     bun run dev
     ```

     Bash:
     ```bash
     export CONTROL_PLANE_API_KEY='your-control-plane-api-key'
     bun run dev
     ```
     If Superagent is already running, restart it so it inherits the updated environment.

     You can also supply the key directly at startup, if needed:
     ```text
     /mcp tunnel start --provider openai --tunnel-id <YOUR_TUNNEL_ID> --api-key <YOUR_CONTROL_PLANE_API_KEY>
     ```
     Or from the CLI:
     ```bash
     superagent mcp tunnel start --provider openai --tunnel-id <YOUR_TUNNEL_ID> --api-key <YOUR_CONTROL_PLANE_API_KEY>
     ```

2. **Run Diagnostics**:
   Verify prerequisites, binary installation, control plane credentials, and port availability:
   ```bash
   superagent mcp tunnel doctor
   # Or in interactive terminal:
   /mcp tunnel doctor
   ```

3. **Start an OpenAI Secure MCP Tunnel**:
   ```bash
   # Start with your tunnel ID created in OpenAI Platform (format: tunnel_<32 hex chars>):
   superagent mcp tunnel start --provider openai --tunnel-id tunnel_0123456789abcdef0123456789abcdef

   # Allow destructive file/shell tools (e.g. for write access):
   superagent mcp tunnel start --provider openai --tunnel-id tunnel_0123456789abcdef0123456789abcdef --allow-dangerous

   # Start with OAuth 2.1 user-consent flow if specifically required:
   superagent mcp tunnel start --provider openai --tunnel-id tunnel_0123456789abcdef0123456789abcdef --mcp-auth oauth

    # Interactive slash command equivalent:
    /mcp tunnel start --provider openai --tunnel-id tunnel_0123456789abcdef0123456789abcdef
   ```
   *Note*: Superagent automatically creates the required profile directory (`%APPDATA%\tunnel-client` on Windows or `~/.config/tunnel-client` on Unix) and generates the valid `superagent-mcp.yaml` profile before launching `tunnel-client`.

4. **Connecting in ChatGPT Connectors / Custom MCP**:
   When connecting your OpenAI Secure MCP Tunnel in ChatGPT:
   - In ChatGPT, navigate to **Settings > Connectors** (or **Custom MCP Servers / Plugins**) and click **Add custom MCP server**.
   - **Connection**: Select **Tunnel** (toggle the pill from *Server URL* to *Tunnel*).
   - **Tunnel ID**: Enter your tunnel ID (e.g. `tunnel_0123456789abcdef0123456789abcdef`).
   - **Authentication Choices**:
     - **Option A: `No authentication` (Fastest & Recommended)**:
       Since OpenAI Secure MCP Tunnels are already encrypted and authenticated at the control plane using your runtime API key, selecting **No authentication** allows ChatGPT to connect directly through the tunnel. Local bearer credentials are automatically injected by `tunnel-client`.
       Check *I understand and want to continue* and click **Create as a plugin**.
     - **Option B: `OAuth` (Zero Trust with One-Time Bootstrap Approval)**:
       If you want full OAuth 2.1 authorization consent (recommended when running with `--allow-dangerous` write/exec tools):
       1. Start Superagent with `--mcp-auth oauth`:
          ```bash
          superagent mcp tunnel start --openai --tunnel-id <YOUR_TUNNEL_ID> --mcp-auth oauth --allow-dangerous
          ```
       2. Superagent will initialize the OAuth 2.1 server, serve RFC 8414/9728 metadata through the tunnel, and print a one-time bootstrap approval code in your terminal (e.g. `One-time bootstrap approval code: a1b2c3d4`).
       3. In ChatGPT, set **Authentication** to **OAuth**, then click **Advanced OAuth settings**:
          - **Registration method**: User-Defined OAuth Client
          - **OAuth client ID**: Enter any name (e.g. `chatgpt` or `superagent`).
          - **OAuth client secret**: Leave empty (PKCE S256 requires no secret).
          - **Token endpoint auth method**: `none`.
       4. Return to the main modal, check *I understand and want to continue*, and click **Create as a plugin**.
       5. Your browser will open the Superagent authorization consent page (`http://127.0.0.1:9227/oauth/authorize`). Enter the bootstrap code printed in your terminal and click **Approve**.

5. **Connect OpenAI Responses API**:
   Use the public endpoint URL in your Responses API payload:
   ```json
   {
     "model": "gpt-4.5-preview",
     "tools": [
       {
         "type": "mcp",
         "server_url": "https://my-agent-tunnel.tunnels.openai.com/mcp",
         "headers": {
           "Authorization": "Bearer <your-mcp-bearer-token>"
         }
       }
     ]
   }
   ```

6. **Manage & Stop**:
   ```bash
   superagent mcp tunnel list             # Inspect active tunnels, URLs, and PID
   superagent mcp tunnel stop             # Stop active MCP tunnel
   ```

#### MCP tools for Muse

Superagent exposes MCP over Streamable HTTP. The MCP HTTP endpoint and Muse's authenticated WebSocket tunnel are separate connections: the MCP client calls a Superagent tool, and Superagent uses its active Muse WebSocket watcher for direct chat.

| Tool | Access | Purpose |
|---|---|---|
| `superagent_muse_chat_status` | Safe, read-only | Check watcher, WebSocket transport, connection, and direct-chat readiness. |
| `superagent_muse_chat` | Dangerous, requires opt-in | Send one conversational message and wait for Muse's correlated reply. Default timeout is 30 seconds; allowed range is 1 to 120 seconds. |
| `superagent_telegram_send_to_muse` | Dangerous, requires opt-in | Deliver a message through the configured Telegram group. Telegram acceptance does not prove Muse processed or answered it. |
| `superagent_muse_tunnel_start` | Dangerous, requires opt-in | Start the verified Muse WebSocket watcher and tunnel. |
| `superagent_muse_tunnel_restart` | Dangerous, requires opt-in | Restart only the verified Muse tunnel, not the MCP HTTP server. |

Recommended direct-chat workflow: call `superagent_muse_chat_status`, start the Muse tunnel if necessary, connect the Muse client, then call `superagent_muse_chat`. The response is successful only after a correlated chat reply with `reply_to` matching the request ID is received. Timeouts and disconnects are reported as errors, not successful conversations.

For request examples and transport details, see [Muse MCP workflows](docs/mcp/muse-chat-workflows.md).

### Selfdev — Default-On Learning

Selfdev is enabled by default for new configuration and collects bounded, redacted task evidence to propose operational lessons. Candidates require explicit review/approval before prompt injection. Use `superagent selfdev status`, `superagent selfdev doctor`, and `superagent selfdev metrics` to inspect it; use `superagent selfdev disable` to persistently opt out. See [Selfdev operations and safety](docs/selfdev.md) and the [Selfdev development plan](docs/plans/2026-10-14-selfdev-default-on-development-plan.md).

### Brain — Autonomous Scratch, Multi-Agent Tasks and Recovery

Brain stores per-session scratch files, finalized artifacts, bounded checkpoints and delegated-job references outside project worktrees under `~/.superagent-r/brain`. It works with the interactive CLI, MCP, and the [T-Line Brain Explorer](https://github.com/RudyCity/t-line); it does **not** turn scratch folders into an OS sandbox. Normal chat session persistence can initialize Brain, while `/brain delegate.start` and MCP `task.autostart` create isolated agent task scratch when delegating work.

**CLI and suggestions.** Type `/brain ` or `/scratch ` to see nested autocomplete; `/brain help` lists the complete commands and argument syntax. The canonical suggestion catalog lives in `src/core/commands/commandCatalog.ts` and is synchronized into T-Line with checksums.

```text
/brain help
/brain create [sessionId]
/brain list
/brain inspect
/brain files
/brain metrics
/brain task.create <title>
/brain task.list
/brain task.claim <taskId> [agentId]
/brain task.checkpoint <taskId> <agentId> <note>
/brain task.transfer <taskId> <fromAgent> <toAgent>
/brain task.resume <taskId>
/brain task.complete <taskId> [agentId]
/brain delegate.start agy <prompt>
/brain delegate.start claude <prompt>
/brain delegate.start codex <prompt>
/brain jobs
/brain get <jobId>
/brain tail <jobId>
/brain cancel <jobId>
/brain task.reconcile
/brain artifact.recover
/brain search <query>
/brain annotate <artifacts/file> <summary>
/brain promote <jobId> [outputFilename]
/brain remember <artifacts/file>
/brain storage [sessionId]
/brain retention [7|30|90]
/brain clean <sessionId>
/brain clean.confirm <sessionId> <challenge>
```

A delegated CLI runs under `scratch/agents/<agent>/<taskId>/`. Multiple logical collaborators use exclusive task ownership, explicit handoff, and checksum-verified artifacts; task checkpoints are recoverable across reconnects and filtered by registered project provenance. `task.reconcile` inspects existing CLI Bridge jobs and **does not** automatically rerun an uncertain or failed job. Cleanup uses a separate prepare/confirm challenge and refuses active nested delegations.

**MCP:** Discover `superagent_brain` through `superagent_tool_search` in default Gateway mode. Actions include `task.autostart`, `task.create`, `task.claim`, `task.checkpoint`, `task.handoff`, `task.transfer`, `task.resume`, `task.reconcile`, `task.reconcile.all`, `task.retry`, `task.cancel.request`, `delegate.promote.batch`, `artifact.recover`, and `task.credential.status/rotate/revoke`. **These dotted MCP actions are not all executable slash commands.** Remote task mutations require the task-scoped `agentCredential`, not just a self-declared `agentId`. Credentials are hashed at rest, default to 24-hour validity, and support one-time rotation and revocation; do not put them in prompts, shared artifacts or logs.

Batch artifact promotion verifies all source hashes and writes a recoverable transaction journal. Promotion is create-only, quota-checked, and can roll back an interrupted batch; it is **not** an atomic snapshot for external filesystem readers at every instant. RMemory updates remain explicit, never automatic based solely on task text.

**Documentation drift protection:** `bun scripts/check-brain-docs.ts` validates Markdown command examples, installation code fences, Brain links and referenced Bun scripts during the Brain release gate. The T-Line counterpart `bun scripts/check-brain-docs.cjs` independently checks desktop startup commands and source layout. This does not perform OAuth login or launch a desktop app.

**Phase 7 launch recovery:** `/brain task.launch.inspect <taskId>` lists verified CLI Bridge evidence for an unresolved delegation. If exactly one matching job exists, `/brain task.launch.recover <taskId> <jobId> CONFIRM` attaches it without spawning another process. When evidence is missing or ambiguous, the reservation stays locked. Remote MCP actions `task.launch.inspect` and `task.launch.recover` require the task owner's recovery credential; `task.credential.audit` shows a redacted, bounded change log. See [Phase 7 runtime acceptance](docs/audits/2026-10-23-brain-phase-7-runtime-acceptance.md).

**Verification and remaining live gates:**

```bash
bun scripts/sync-brain-runtime.ts --check
bun scripts/verify-brain-release.ts --with-tline
```

The release check builds both applications and tests Brain/MCP/backend/UI parity. A public OAuth tunnel round trip, installed T-Line GUI interaction, and real Claude delegation require separate operator-run acceptance. Do not restart an unrelated active tunnel to force those checks.

Documentation: [Phase 5 task orchestration](docs/plans/2026-10-22-autonomous-brain-phase-5-implementation.md), [P0–P2 hardening](docs/plans/2026-10-22-brain-p0-p2-hardening-implementation.md), [Phase 6 reliability](docs/plans/2026-10-22-brain-phase-6-reliability-and-acceptance.md), and [command suggestions parity](docs/plans/2026-10-23-brain-command-suggestions-parity.md).

### Keyboard Shortcuts

| Shortcut | Description |
|---|---|
| `Ctrl+C` | Abort current process / Exit if input is empty |
| `Ctrl+P` | Show checkpoints interactive wizard dialog |
| `Ctrl+H` | Toggle search history panel |
| `Ctrl+T` | Toggle checklist focus mode (when plan is approved) |
| `Ctrl+O` | Cycle through and toggle expand/collapse of tool/system entries |
| `Esc` | Reset input focus, cancel active wizard, or reset scroll. With an active tunnel: opens the tunnel menu (stop / message Muse / continue) |
| `↑/↓` | Scroll message viewer or navigate CLI history |
| `Tab` | Autocomplete slash commands or cycle suggestions |
| `Click` | Focus or scroll panels via terminal mouse interaction |
| `!<command>` | Quick shortcut to run a shell command (e.g. `!npm run dev`) |

---

## 🏗️ Architecture

```text
                               ┌────────────────────────────────┐
                               │       Superagent CLI           │
                               └───────┬────────────┬───────────┘
                                       │            │
            ┌──────────────────────────┼────────────┼──────────────────────────┐
            ▼                          ▼            ▼                          ▼
┌────────────────────────┐  ┌──────────────────┐ ┌──────────────────┐ ┌────────────────────────┐
│  Single Agent Mode     │  │ Headless Daemon  │ │ Omnichannel      │ │  t-line Desktop Client │
│  (Direct Execution)    │  │ & Cron Scheduler │ │ Messaging Gateway│ │  (Automatic Bridge)    │
└───────────┬────────────┘  └──────────────────┘ └──────────────────┘ └────────────────────────┘
            │
 ┌──────────┼──────────────────────┐
 ▼          ▼                      ▼
┌────────┐ ┌────────────────────┐ ┌────────────────────┐
│ Shell  │ │ Atomic Subagents   │ │ Skill Synthesizer  │
│ & File │ │ (Coder/Tester/etc) │ │ (Autonomous Traj)  │
└────────┘ └────────────────────┘ └────────────────────┘
```

<details>
<summary><b>View Experimental 3-Tier Multi-Agent System</b></summary>

<br />

When enabled via `--multi`, Superagent runs a 3-tier hierarchy:

```text
Master Agent (Orchestrator)
  ├── Superagent A (Git Worktree 1 - Feature A)
  │     ├── Subagent (Search & Read)
  │     └── Subagent (Code Writer)
  └── Superagent B (Git Worktree 2 - Feature B)
        └── Subagent (Tester / Debugger)
```
</details>

---

## 📄 License & Author

Developed by **Rudy City** ([@RudyCity](https://github.com/RudyCity)) • 📧 Contact: [hrudy715@gmail.com](mailto:hrudy715@gmail.com)

Distributed under the [MIT License](LICENSE).

### MCP OAuth mode — manual verification status (2026-10-06)

Automated protocol tests cover: OAuth discovery, PKCE (S256) success/failure, owner approval via one-time bootstrap code, authorization-code replay rejection, token refresh rotation, per-session isolation, reconnect, DELETE cleanup, Origin/Host validation, and tool allowlisting (94 tests passing).

Manual verification (requires user action — NOT yet run):

- [ ] **MCP Inspector**: start `/mcp tunnel start --provider cloudflare --mcp-auth oauth` in a disposable workspace, point MCP Inspector at the public `/mcp` URL, complete OAuth, verify tools/list + one safe tool call.
- [ ] **ChatGPT Developer Mode**: create a draft custom MCP app with the public `/mcp` URL, complete authorization, scan tools, call one safe read-only tool.
- [ ] **Denied dangerous tool**: in OAuth mode with a safe-only scope, attempt a dangerous tool call; verify a clear approval/auth error and no execution.

Endpoint mode for manual tests: `--mcp-auth oauth` (OAuth 2.1 + PKCE). Static-bearer mode remains the default for backward compatibility.

### SuperAgent Studio storage namespace (October 2026)

Local Studio data is stored under `<workspace>/.superagent/studio`. Existing
`.superagent/motion` workspaces can be migrated via `superagent studio migrate
--workspace PATH --json` (dry-run), then `--apply` (atomic rename). On Windows,
a directory handle held by an editor can block the rename; with a verified backup
and **no active legacy writers**, `--apply --verified-copy` verifies the full
source/target SHA-256 inventories and activates Studio while retaining the old
folder as a rollback copy. Both namespaces without the verified cutover marker
remain blocked; do not manually copy, delete or merge either directory.
See [the migration plan](docs/plans/2026-10-22-superagent-studio-canonical-migration.md).

### Studio to Code — offline SVG and React exports (developer preview)

Instead of rasterizing a scene into MP4, the same revisioned Studio composition
can export **editable HTML with inline SVG elements and a native browser timeline**.
The HTML contains controls and supports four trigger modes: autoplay, scroll,
click and hover.

```bash
superagent studio new --name "Animated hero" --workspace . --json
superagent studio export-code STUDIO_PROJECT_ID --trigger scroll --workspace . --json
superagent studio export-code STUDIO_PROJECT_ID --format react --trigger click --workspace . --json
```

The CLI creates revision-scoped `.html` files (default) or a `.tsx` React/Next.js
client component when `--format react` is selected. React output uses a
sandboxed iframe with the exact offline HTML document; direct editable JSX
layers remain planned.

The CLI creates `.superagent/studio/code/<project-id>-r<revision>-<trigger>.html`
and refuses to overwrite a previous export of the same revision. Authenticated
T-Line Studio clients may download the same artifact through
`GET /api/studio/projects/:id/code.html?trigger=scroll`; the old `/api/motion`
route also works. The T-Line Studio editor offers an **Export Web Code** control.

**Interaction Rules v1:** each revisioned Studio composition may contain up
to 12 validated `interactionGraph.bindings`, authored in T-Line's **Interaction
Graph** panel. Allowed events are ready, click, mouseenter, mouseleave, focus and
scroll; allowed actions are play, pause, replay and seek. The target is the stage
or a named vector/text layer (scroll and ready are stage-only). Scroll maps
viewport progress to timeline seek. These rules override the old single trigger
for exported HTML and React components, while MP4 rendering remains unchanged.
Each edit is persisted with Studio's optimistic revision guard; removing a
referenced layer is rejected until the affected interaction is removed.

**Currently supported:** native text, rectangle and SVG path layers, revisioned
keyframes, timing, scale/rotation/position/opacity/stroke-dashoffset properties,
and scene-level scroll/click/hover triggers. The default output embeds a
first-party requestAnimationFrame runtime with **no external runtime scripts or
network access required**. The experimental legacy GSAP code adapter is not
exposed through public CLI/API pending third-party licensing review.

**Experimental single-object reference video reconstruction (CLI only):**

```bash
superagent studio import-video --file path/inside/workspace/clip.mp4 --workspace . --json
superagent studio reconstruct-video VIDEO_ID --workspace . --json
superagent studio export-code NEW_PROJECT_ID --format html --workspace . --json
```

This bounded, deterministic P3 prototype decodes three sample frames of an
already-imported, SHA-256 verified 1–12-second MP4/WebM; for a single dominant
**bright silhouette on a dark background** it traces SVG geometry, infers
linear x/y keyframes and saves a new revisioned Studio project. It refuses
unstable foreground contours instead of inventing scene content. It does NOT
reconstruct arbitrary real-world footage or text, audio, multi-object motion,
3D graphics, rotation, occlusion, or original source code. Its reported
confidence measures heuristic contour stability—not pixel-level fidelity.
It does not call an AI model or external provider.

**Experimental multi-object video reconstruction (P3 prototype):**

```bash
superagent studio import-video --file path/inside/workspace/clip.mp4 --workspace . --json
superagent studio reconstruct-video-multi VIDEO_ID --workspace . --json
superagent studio export-code NEW_PROJECT_ID --format react --workspace . --json
```

Optional local Chrome/FFmpeg/Pillow/Playwright smoke tests:
`python scripts/studio_video_multi_browser_smoke.py --palette dark --json` and
`python scripts/studio_video_multi_browser_smoke.py --palette light --json`.


For **2–4 separated high-contrast shapes on a stable solid-color background**
(light or dark), Studio tracks 5–9 duration-bounded frames (adding samples to
high-motion intervals), matches foreground components using RGB contrast, and
saves editable SVG layers with independent x/y keyframes. The original object
colors and corner-inferred background are retained within video codec tolerance.
Samples now reach approximately 96% of the clip duration to reject shapes that
disappear near the end; uncertain/obstructed or changing backgrounds fail closed.
Ambiguous matches, missing shapes or backgrounds that vary across samples
are rejected **before** the project is created. The source is an imported,
SHA-256-verified MP4/WebM (up to 12 MiB, 1–12 s, maximum 1280×720).

The result returns three **foreground mask IoU** measurements, plus up to
two independent **out-of-sample interpolation IoU** checks. Poor matches
are rejected before project creation. It saves an
original-vs-Studio comparison PNG at
`.superagent/studio/code/<project-id>-r<revision>-multi-review.png`
(or the verified legacy Studio storage root). Values describe only three
sampled high-contrast masks, not motion or color fidelity across the full
video. The original video is never embedded in the exported code.

The T-Line editor also exposes a capability-gated **Video → Editable Studio
Code** panel to upload an authorized video, run this prototype, inspect the
three-frame comparison and open the newly created Studio project. Behind the
global T-Line/SuperAgent auth and workspace gate, the API routes are
`POST /api/studio/videos`, `POST /api/studio/reconstruct/multi`, and
`GET /api/studio/projects/:id/reconstruction-review.png?revision=N`.
This remains developer-preview, not an AI vision service.

**Experimental local English OCR → editable Studio TextLayer (P3):**

```bash
superagent studio import-video --file path/inside/workspace/caption.mp4 --workspace . --json
superagent studio reconstruct-video-text VIDEO_ID --workspace . --json
superagent studio export-code NEW_PROJECT_ID --format html --workspace . --json
```

Requires `tesseract` with English `eng` data on the local OS PATH (not
bundled with Studio/T-Line). The tool processes an imported, SHA-256-verified
1–12 s video of stable **English caption lines on a solid background**,
extracts three samples, and only persists a fresh Studio project if 1–3
caption lines have high OCR confidence (≥72 per word), identical text across
samples and stable geometry. It creates editable `text` layers and x/y
keyframes in a revisioned project. New/disappearing/changed text, low-confidence
results and inconsistent backgrounds **fail closed**. Text styling, font family,
typographic metrics and color are only estimates—not visual parity. This is
local OCR, **not semantic video understanding**. In T-Line's experimental
Video-to-Code panel select **Editable Text (English OCR)** if an updated
Studio backend advertises `experimentalTextOcrReconstruction`. HTTP route:
`POST /api/studio/reconstruct/text` through existing authorization/workspace
gate. Only English OCR data is currently supported.

**Not yet supported:** general video-to-code reverse engineering, editable
DOM/SVG reconstruction of arbitrary footage, raster/image/video/audio assets
in the exported web code, or native per-layer React/Next.js JSX (only a
sandboxed TSX wrapper is generated). Unsupported assets are rejected instead
of silently omitted. The existing MP4/WebM/GIF renderer is unchanged. Review
GSAP's standard license before redistributing its runtime with products.

### Motion Studio (developer preview)

Motion Studio stores revision-checked scenes and media inside the selected **local workspace**. The native editor is delivered by the separate T-Line Desktop project; no independent browser Studio or live packaged-Tauri integration is implied by the backend API.

**T-Line startup compatibility (October 2026):** The T-Line desktop launcher and T-Line Express backend must be updated together to support the nonce-HMAC identity handshake introduced in T-Line main commit 9745b01. The desktop intentionally refuses to attach to older or unidentified services on port 5779 rather than killing another process. This handshake is *not* a SuperAgent Motion API endpoint. See [T-Line startup / Motion Studio handoff](docs/plans/2026-10-21-t-line-startup-motion-handoff.md) for version coordination, safe migration and remaining installed-app gates.

```bash
superagent motion doctor --json
superagent motion new --name "Launch video" --workspace . --json
superagent motion import-image --file ./assets/product.png --workspace . --json
superagent motion import-audio --file ./assets/voice.wav --workspace . --json
superagent motion edit MOTION_ID --base-revision 1 --edits-file ./edits.json --workspace . --json
superagent motion render MOTION_ID --width 1920 --detach --workspace . --json
superagent motion jobs --workspace . --json
```

`edits.json` contains a JSON array of existing declarative `MotionEdit` operations, e.g. `[{"type":"set-property","layerId":"title","property":"x","value":200}]`. Asset IDs returned by imports may be included in `add-layer` and `set-audio-tracks` operations. All local input files must resolve inside the workspace and may not be symlinks. Render profile currently caps at 1800 frames and 1920px output dimensions. Worker recovery is operator-mediated: use `motion recovery` for read-only diagnostics and `motion recover JOB_ID --ack-stale` only after verifying actual stale ownership.

The interactive terminal supports `/motion import-image ./assets/product.png`, `/motion import-audio ./assets/voice.wav`, and `/motion edit-json MOTION_ID 1 [{"type":"set-property","layerId":"title","property":"x","value":200}]`. MCP clients expose 11 `superagent_motion_*` tools, including dangerous/write-scoped `superagent_motion_import_image` and `superagent_motion_import_audio` accepting bounded canonical base64. Live MCP servers require their usual controlled reload before newly added tools become visible; don't interrupt active Hermes sessions just for discovery.

Motion render maintenance is operator-scoped and never deletes completed MP4 videos:

```bash
superagent motion storage --days 7 --workspace . --json
superagent motion prune --days 7 --apply --workspace . --json
```

`storage` is a read-only preview; `prune --apply` removes only old, unclaimed failed/cancelled/interrupted job records after explicit confirmation. Active/suspicious claims, partial outputs, and finished videos are preserved. Safe `superagent_motion_storage` and authenticated `GET /api/motion/storage` provide read-only diagnostics for agents/T-Line. This is *not* unattended crash recovery.

### Recovering orphaned queued Motion renders

Motion render job records and immutable source snapshots persist across CLI sessions. To inspect jobs that have been queued for at least 30 seconds but lack a confirmed worker claim:

    superagent motion queue-recovery --workspace . --json

When you have verified those queued jobs are not already owned by a running worker, explicitly dispatch up to four eligible jobs:

    superagent motion dispatch-queue --apply --limit 4 --min-age-seconds 30 --workspace . --json

Existing runner/waiting/slot/dispatch/cancellation claims and invalid snapshots block redispatch; unconfirmed launches preserve a dispatch lock for operator inspection. This never restarts rendering jobs automatically or kills workers. The authenticated GET /api/motion/queue-recovery endpoint and safe superagent_motion_queue_recovery MCP tool expose diagnostics only. T-Line presents eligible/blocked counts but cannot initiate destructive redispatch.

### Optional Motion FIFO supervisor (SuperAgent)

Existing immediate renders keep working unchanged. In a separate SuperAgent terminal, start the foreground FIFO supervisor:

    superagent motion supervisor --watch --workspace . --interval-ms 2000

Submit a revision-pinned job through CLI, or choose FIFO in T-Line Motion Studio, or set supervised=true in an MCP/HTTP Motion render request:

    superagent motion render MOTION_ID --width 640 --supervised --workspace . --json
    superagent motion supervisor-status --workspace . --json

Alternatively dispatch a single batch and exit:

    superagent motion supervisor --once --workspace . --json

This explicit opt-in supervisor respects the shared 1–4 renderer capacity and immutable source/asset verification; it does not kill active workers or automatically reclaim leader/worker locks after crashes. It is NOT unattended restart of crashed video encoders. Operators must inspect stale ownership before manual recovery. Queued supervised jobs without worker claims can be cancelled immediately.

### Prompt-first AI Motion Director (developer preview)

Create a short editable text-and-shape motion graphic using the active configured SuperAgent AI model:

    superagent motion generate --prompt "Buat motion promo Laris 10 detik, gaya modern gelap" --width 640 --workspace . --json
    superagent motion revise MOTION_ID --prompt "Buat judul terakhir lebih singkat" --width 640 --workspace . --json
    superagent motion status JOB_ID --workspace . --json

Equivalent slash commands: /motion generate and /motion revise. The native agent also has motion_generate, motion_revise and motion_status. MCP clients can call superagent_motion_generate/revise when authorized for write+execute. T-Line Motion Studio has a prompt/revision input and reuses its authenticated render progress/preview; manual timeline editing remains available.

The AI Director plans 2–20s motion graphics made only from text/colored rectangles and basic transformations. It does not create music, spoken dialogue, complex effects, stock imagery, generated photos, or video footage. Prompts are compiled into validated declarative scene operations, never executable AI-generated code. Production-grade visual QA, connected model-provider certification and packaged Tauri E2E remain open.

Motion Director now supports optional model-selected motion presets: slide-left, slide-up, tilt and fade, with cut or crossfade transitions. Its output includes deterministic frame-sampled quality checks of titles, contrast and overflow. Inspect any Motion project via the authenticated GET /api/motion/projects/MOTION_ID/quality route. These checks are not AI visual critique, do not automatically create third-party media and do not certify professional typography. T-Line displays a read-only quality report beside the editable motion scene after generation or manual edits.

### Prompt-based Motion with workspace images and WAV

Motion Director can now use existing workspace-uploaded assets: PNG/JPEG/WebP image/logo (max 1 MB) and canonical PCM16 WAV soundtrack (max 2 MB). In T-Line Motion Studio, attach the image and/or WAV directly beside the AI Motion prompt; the UI uploads them to the workspace before generation and supports prompt-based revisions. CLI and agent/MCP/HTTP generate/revise take optional imageAssetId, audioAssetId and audioGain fields, using verified content hashes rather than filesystem paths. CLI example after upload:

    superagent motion generate --prompt "Create a product promo with my supplied logo and music" --image-asset asset-SHA256 --audio-asset audio-SHA256 --audio-gain 0.7 --width 640 --workspace .

The output positions one attached image above the text area and mixes the supplied WAV in the MP4; edits remain reversible with ordinary project revisions. Short tracks do not automatically loop. Only user-provided local media is used: image generation, soundtrack synthesis and TTS are not implemented.

### Motion Director B3: scene product images, soundtrack loop, offline narration

With an updated SuperAgent daemon and T-Line Desktop, you can attach up to three product images to the AI Motion prompt. For 2–3 images, the images map by order to the generated storyboard scenes (request the same number of scenes in the prompt). They fade in and out with scene animation and remain editable image layers. A single legacy image/logo attachment continues to work.

Turn on Loop WAV to video end in the AI prompt or audio mixer to repeat a short uploaded PCM16 WAV for the MP4's full duration, with its fade-out at the end of the video. The audio track schema stores the optional loop flag so the editor preview and FFmpeg export agree.

For optional **offline voice-over**, an operator must separately install a compatible Piper executable and local voice model (including its model JSON configuration) and set:

    SUPERAGENT_MOTION_PIPER_BIN=C:\path\to\piper.exe
    SUPERAGENT_MOTION_PIPER_MODEL=C:\path\to\voice.onnx

Restart the SuperAgent server process after setting these environment variables. When the binary and model are present, T-Line exposes the narration transcript and gain controls. Narration is synthesized locally into a bounded PCM16 WAV and mixed as an additional audio track. If Piper is absent or incompatible, voice-over is unavailable; no silent placeholder, automatic download or cloud fallback is created. **Piper voice quality and live binary-to-MP4 narration were not certified in this development session.**

CLI examples after pre-uploading image/audio files to the Motion workspace:

    superagent motion generate --prompt "Create a three-scene launch motion" --scene-images asset-HASH1,asset-HASH2,asset-HASH3 --audio-asset audio-HASH --audio-loop true --width 640 --workspace .
    superagent motion generate --prompt "Create a narrated promo" --voiceover-text "Welcome to our product launch" --width 640 --workspace .

The hash IDs above are placeholders, not valid usable IDs. Existing 1MB image and 2MB/30s WAV limits, max 3 scene images and 4 combined audio tracks apply. This is still a developer preview rather than a full video footage/TTS editor.

### Motion Studio expanded previews (developer preview)

Generate editable 16:9, 1:1 or 9:16 video (e.g. superagent motion generate --prompt "Promo produk portrait" --aspect-ratio 9:16 --width 640 --workspace .). Model-approved animation presets include pop-up/pop-left easing with position overshoot. The T-Line quality panel can request authenticated frame PNGs rendered with the exact same Canvas scene pipeline as the MP4. These are human inspection aids, not automatic AI/vision approval.

With an operator-installed Piper executable and model, new video prompts can choose automatic narration from the storyboard scene text; validated music and voiceover tracks are mixed by FFmpeg with music sidechain ducking. Without Piper, voice synthesis is unavailable and fails explicitly. Automatic footage creation, online soundtrack generation, licensed asset search, long-form editing and production-ready Tauri/Piper end-to-end tests remain out of scope.

### Motion Studio sampled AI vision and SubRip captions

On an updated SuperAgent service with a vision-capable model, the T-Line Motion quality panel offers AI Vision Review (an explicit image-model call), Review & auto-improve once (one permitted model review plus at most one declarative revision and new MP4), and Export scene subtitles (.srt). Without an image-capable model the vision operation fails with a clear 503. These are authenticated, workspace-scoped service requests, not unauthenticated public model APIs.

Captions describe authored scene headlines and subtitles with non-overlapping cue times. They do not transcribe voiceover WAV audio. Rounded rectangle layers now accept an optional, bounded cornerRadius matching SVG and Canvas/MP4 output, editable from T-Line's inspector. One-pass visual repair is an opt-in helper and can change scene text/layout: inspect the resulting motion before publishing.

Video footage, closed captions automatically transcribed from audio, genuine multi-pass vision production scoring, packaged desktop provider E2E, autonomous safe crash recovery and full professional motion effects remain release gates.

## Senopati V2 (Experimental Shadow)

Five-head Senopati V2 candidate inference is available only as an **explicit, read-only shadow**. It does not replace the active Senopati ONNX, authorize tools, or approve plans. Use `bun scripts/run-senopati-v2-shadow.ts --model <candidate-json> --text <message>` and `bun scripts/check-senopati-v2-parity.ts <candidate-json> <rudy-oracle-jsonl>`. See `docs/plans/2026-10-22-senopati-v2-shadow-implementation.md` for metrics, safety constraints and release blockers.

### YOLO path/drive blocklist (local)

Use `/yolo block add "E:\\"` to block a drive, or `/yolo block add "D:\Private"` for a directory. Manage with `/yolo block remove "D:\Private"`, `/yolo block list`, `/yolo block check "D:\Private\file.txt"`, and `/yolo block clear`. Entries persist in `~/.superagent-r/yolo-blocklist.json` and are checked before standard agent tool dispatch and MCP tool dispatch, including Full YOLO. This is a **best-effort application-level guard**, not an OS filesystem sandbox: dynamically assembled shell commands, subprocesses, direct CDP browser actions, SSH remote paths, or alternate tools may evade text/path inspection. For strict protection, also use OS filesystem ACLs or a sandboxed execution identity.

### Windows OS isolation roadmap and security command

The existing `/yolo block` implementation is an **application-level best-effort** guard, not an OS sandbox. Windows filesystem ACLs apply to an operating-system identity, not to the YOLO toggle. Recommended deployment runs shell/tools under a *separate non-administrator Windows account* while the interactive orchestrator remains outside it; restrict that account's access using explicit allow/deny ACL rules. Never apply ACL changes to the current user's account or the entire drive without a rollback plan. The CLI `/security` command manages the application's blocklist and provides Windows sandbox diagnostics. OS enforcement requires separately provisioning the runner and validating its identity, with optional AppContainer/VM for stronger isolation. Browser CDP and remotely executed tools need their own isolation boundaries. Do not interpret `/yolo full` as permission to bypass OS controls.

#### Windows ACL helper (dry-run default)

The operator can inspect an existing dedicated runner account and plan ACL changes with `powershell -NoProfile -File scripts/windows-sandbox-acl.ps1 -Action Block -Path 'D:\Private' -Runner '.\superagent_runner'`. After independently verifying the account and recovery plan, pass `-Apply` to request Windows ACL changes. `-Action Status` inspects the ACL, while `-Action Unblock` plans removal of that account's explicit deny ACE. Before applying, the helper saves an ACL backup in the current operator's TEMP directory. The helper deliberately refuses whole-drive roots, current-user identities and broad security groups. Run separately under an administrator with a controlled audit process; the helper **does not start an isolated runner** or claim the application is sandboxed. `/security sandbox enable` therefore fails closed until isolated process execution is actually provisioned.

Available CLI commands: `/security block add <path>`, `/security block remove <path>`, `/security block list`, `/security block check <path>`, `/security block clear`, `/security sandbox status`, and `/security sandbox doctor`. CLI autocomplete offers these actions. Application blocks persist independently of YOLO mode. Windows ACLs only constrain processes launched as the restricted OS identity, not processes under your normal user or elevated identity.

#### Running under the dedicated Windows identity

Use `powershell -File scripts/windows-run-as-runner.ps1 -Runner '.\superagent_runner' -Workspace 'D:\path\to\superagent' -DryRun` to inspect a run-as launch; remove `-DryRun` to prompt for that account's password and launch CLI under the Windows token of the account. No password is written to repo/config. First provision that **non-administrator** local account, grant it only intended working-directory rights, ensure Bun is accessible to it, and apply/verify deny rules as that account. This launcher supports CLI only: MCP STDIO and T-Line integration require their host/service to use the restricted Windows account. `/security sandbox doctor` reports the actual OS identity and never reports ACLs as verified without an access probe. Provisioning a separate account does not itself protect data unless ACLs are correctly applied, and a compromised orchestrator with an unrestricted account is outside this boundary.

#### Strict OS sandbox startup gate (CLI/MCP and T-Line)

Set `SUPERAGENT_REQUIRE_OS_SANDBOX=1`, `SUPERAGENT_OS_RUNNER_IDENTITY=HOST\superagent_runner`, and `SUPERAGENT_OS_DENIED_PROBE_PATH=C:\restricted\existing-probe.txt` **in the launching process environment**. The SuperAgent CLI (including `--mcp-server`) refuses startup unless Windows `whoami` matches the configured identity and attempting to open the existing probe file fails with an actual permission error (`EACCES` or `EPERM`). Missing files or accessible files fail the check. T-Line's backend performs the same preflight before launching its managed SuperAgent server; spawn inherits the backend's Windows token, so its backend itself must be started under the restricted account. These checks verify one denied-file sample only, **not full isolation**, ACL completeness, or resistance to privileges gained through other processes. This does not alter ACLs or provision the Windows account. The helper `scripts/windows-run-as-runner.ps1` now accepts `-DeniedProbePath` and sets these process-level strict-mode environment variables for CLI launch.

T-Line companion documentation: `../t-line/README.md` describes the inherited backend identity and strict startup check. In strict mode T-Line's managed server only starts after matching the restricted Windows identity and the denied-file probe. The full T-Line application and CDP remain separate trust boundaries.
