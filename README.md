<div align="center">

# 🚀 Superagent

**An interactive, terminal-based AI coding assistant for pair programming, context engineering, and autonomous workflow automation.**

[![Version](https://img.shields.io/github/v/release/RudyCity/superagent?style=flat-square&color=8A2BE2)](https://github.com/RudyCity/superagent/releases)
[![License](https://img.shields.io/github/license/RudyCity/superagent?style=flat-square&color=blue)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh)
[![t-line](https://img.shields.io/badge/Desktop_App-t--line-00D1B2?style=flat-square)](https://github.com/RudyCity/t-line)

<br />

![Superagent Terminal UI](assets/Video_SuperAgent.gif)

</div>

---

## ⚡ Overview

**Superagent** is a high-performance, terminal-native AI coding assistant built for developers. It executes shell commands, inspects and edits codebases, runs test suites, manages multi-file edits, and automates context pruning—all directly from your local terminal.

Superagent also pairs natively with **[t-line](https://github.com/RudyCity/t-line)**, its official desktop client.

---

## ✨ Key Features

- **🎯 Single Agent Mode (Primary)**: Seamless pair programming with live terminal execution, intelligent tool usage, and subagent delegation.
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

Requires [Bun](https://bun.sh) (v1.0 or later) or Node.js.

```bash
# Clone the repository
git clone https://github.com/RudyCity/superagent.git
cd superagent

# Install dependencies & build
bun install
bun run build

# Register globally (optional)
bun install -g .
```

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
| `/mcp` | Manage MCP servers and tunnel providers: `list`, `add`, `remove`, `reload`; tunnel actions include `providers`, `config` (OpenAI Tunnel ID/key: `set-id`, `set-key-env`, `set-key`, `status`, `clear-id`, `clear-key`, `clear`), `start`, `stop`, `restart`, `list`, `status`, `doctor` |
| `/macro` | Manage and run browser macro presets: list, run, delete |
| `/muse` | Coordinate Muse tasks and watch sessions; `/muse tunnel` controls Muse WebSocket only |
| `/telegram` | Manage direct Telegram bot/group operations: `status`, `doctor`, `send`, `config`, `fallback` |
| `/server tunnel` | Manage Superagent REST/SSE server exposure independently |
| `/tunnel` `/tunnels` | Deprecated Muse-only aliases; use `/mcp tunnel` for MCP or `/server tunnel` for REST/SSE |

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
     npm install -g @openai/tunnel-client
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
