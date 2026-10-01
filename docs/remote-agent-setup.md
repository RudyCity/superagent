# Guide: Connecting Superagent with Remote Assistant (Muse) via Telegram

A comprehensive setup guide for connecting **Superagent** (the AI coding assistant running locally on your machine) with **Muse** (a remote AI assistant acting as the planner and cognitive brain) over a private Telegram group bus. Suitable for setup on any machine from scratch.

> **Placeholder Legend** — Replace these with your actual values:
> | Placeholder | Description |
> |---|---|
> | `<BOT_A_USERNAME>` / `<BOT_A_ID>` | Telegram bot belonging to the remote Muse assistant (provided by your remote assistant provider) |
> | `<BOT_B_USERNAME>` | Your local Superagent Telegram bot (created via @BotFather) |
> | `<BOT_B_TOKEN>` | Bot B token received from @BotFather |
> | `<GROUP_ID>` | Numeric ID of your private Telegram group (always negative, e.g. `-1001234567890`) |

---

## 1. Architectural Overview

```text
┌─────────────────────┐         ┌─────────────────────────┐         ┌─────────────────────┐
│     SUPERAGENT      │         │ PRIVATE TELEGRAM GROUP  │         │        MUSE         │
│  (Your local laptop)│         │                         │         │  (Remote assistant) │
│                     │         │  ┌───────────────────┐  │         │                     │
│  /muse <task>       │         │  │ Bot B (Your bot)  │  │         │  High-level         │
│  Executes local     │◄───────►│  │ Bot A (Muse bot)  │  │◄───────►│  reasoning &        │
│  tools: read, glob, │         │  └───────────────────┘  │         │  planning, sends    │
│  grep, write, edit  │         │                         │         │  task_batch calls   │
└─────────────────────┘         └─────────────────────────┘         └─────────────────────┘
```

### Design Principles
- **Task-Level Integration**: Integration occurs at the agent-to-agent task level rather than as a low-latency model provider replacement (`doGenerate`). Muse reasons in large batches, and Superagent executes those batches locally on your file system.
- **Outbound Long-Polling Transport**: Communication uses pure Telegram Bot API long-polling (`getUpdates`). No webhooks, public IP addresses, or open inbound ports are required. Your machine only makes outbound HTTPS requests to `api.telegram.org`.

### Single Task Workflow
1. User enters `/muse <task>` in Superagent. Superagent (via Bot B) posts a `task_request` envelope to the Telegram group.
2. Muse reads the request, reasons through the problem, and replies with a `task_batch` containing tool calls (`read`, `glob`, `ripgrep_search`, `write`, `edit`, `apply_patch`).
3. Superagent executes the tools locally (prompting the user for approval on destructive file changes or commands) and posts a `task_result` envelope back.
4. Steps 2 and 3 repeat until Muse completes the task and posts a `task_done` envelope with a final summary.

---

## 2. Prerequisites

- An active Telegram account.
- Superagent installed with the `remoteAgent` module and `/muse` command available.
- Bot A details from your remote assistant provider: `<BOT_A_USERNAME>` and `<BOT_A_ID>`.

---

## 3. Telegram Setup (Mobile Device)

### 3.1 Create Bot B (Your Bot)
1. Open Telegram and search for **@BotFather**.
2. Send `/newbot` and follow the guided prompts to choose a display name and username.
3. Save your API token securely. Never share or commit this token.

### 3.2 Enable Bot-to-Bot Communication Mode
By default, Telegram bots cannot see messages from other bots. To allow Bot A and Bot B to exchange messages in a group, Bot-to-Bot Communication Mode must be manually enabled:

1. Open **@BotFather** on your mobile Telegram app (ensure Telegram is updated to the latest version).
2. Tap **Open App** (Mini App interface) or send `/mybots`.
3. Select **Bot B** -> **Bot Settings** -> enable **Bot-to-Bot Communication Mode**.
4. Confirm with your remote assistant provider that Bot A also has Bot-to-Bot Communication Mode enabled.

### 3.3 Disable Group Privacy Mode in @BotFather (Critical)
By default, Telegram bots have **Privacy Mode enabled**. When active, Telegram silently discards messages from other bots in groups unless they start with `/` or directly reply to Bot B. To ensure Bot B receives all tool batches:

1. Open **@BotFather** in Telegram.
2. Send `/setprivacy`.
3. Select **Bot B** (`<BOT_B_USERNAME>`).
4. Select **Disable** (BotFather will confirm: *"Privacy mode for <bot> is now disabled. The bot will receive all messages in group chats"*).
5. If privacy mode cannot be disabled, Muse MUST always reply directly to Bot B's messages using `reply_parameters` or `reply_to_message_id`.

### 3.4 Create a Private Telegram Group
1. Create a new **Private Group** in Telegram.
2. Add both **Bot B** and **`<BOT_A_USERNAME>`** (Bot A) as members.
3. Promote **both bots to Group Administrators** with permission to read and send messages.
4. Send a test message in the group (e.g. `ping`).

---

## 4. Superagent Setup (Your Machine)

### 4.1 Configuration
Configure Superagent directly in your terminal using the `/muse config` slash command:

```bash
/muse config botToken <BOT_B_TOKEN>
/muse config groupId <GROUP_ID>
/muse config museBotId <BOT_A_ID>
```

#### Available Configuration Keys:
| Key | Aliases | Description | Example |
|---|---|---|---|
| `botToken` | `bot_token` | API token of Bot B from @BotFather | `/muse config botToken 123456:ABC...` |
| `groupId` | `group_id` | Private Telegram group ID (always negative) | `/muse config groupId -1001234567890` |
| `museBotId` | `muse_bot_id` | Numeric Telegram user ID of Muse bot (Bot A) | `/muse config museBotId 987654321` |
| `as_runner_model` | `as_runner`, `default_runner` | Route regular prompts directly to Muse (on/off) | `/muse config as_runner_model on` |
| `defaultWorkspace` | `workspace` | Default workspace root for tool executions | `/muse config defaultWorkspace ./my-project` |

#### How to Find `<GROUP_ID>`:
- Group IDs in Telegram are always negative numbers (e.g. `-1001234567890`).
- You can find your group ID by temporarily adding `@getmyid_bot` to the group to read the chat ID, or by asking your remote assistant. Once noted, remove `@getmyid_bot`.

Verify your configuration:

```bash
/muse status
```

The output will confirm that credentials are saved in `~/.superagent-r/remote-agent.json`, with the bot token securely masked.

### 4.2 Interactive Autocomplete Suggestions
Superagent includes built-in autocomplete for all `/muse` commands:
- Type `/muse ` and press Tab or Space to view available subcommands (`status`, `config`).
- Type `/muse config ` to view suggestions for all keys (`as_runner_model`, `botToken`, `groupId`, `museBotId`, `defaultWorkspace`).
- Type `/muse config as_runner_model ` to see quick selection options for `on` and `off`.

### 4.3 Test Connection
Run a simple verification task:

```bash
/muse hello
```

Expected sequence in the terminal:
1. Superagent logs: `[Muse] Initiating remote task...` and sends `task_request`.
2. Muse responds with an initial inspection or greeting batch.
3. Superagent returns `task_result`.
4. Muse sends `task_done` and the final answer appears in your terminal.

### 4.4 Managing Sessions and Resetting Context
- **Session Continuity**: Multi-turn prompts automatically preserve the active conversation session ID and include recent dialogue history in the `context` field of `task_request`.
- **Resetting Remote Context**: Use `/muse new` or `/muse reset` to send a `session_reset` envelope over Telegram, clearing Muse's conversation memory for the current session.
- **Cancelling Active Tasks**: Run `/muse stop` or `/muse cancel` to terminate the active remote task immediately. Superagent kills the local poller and sends a `task_cancel` envelope to Muse over Telegram so Muse stops processing immediately.
- **Auto-Cancellation on Interrupt**: Aborting in Superagent (or typing a new task) automatically cleans up any previous remote task, preventing competing zombie pollers and Telegram HTTP 409 Conflict errors.
- **Global Reset**: Running `/new` or `/clear` in Superagent automatically notifies Muse over Telegram while creating a fresh local session.

### 4.5 Optional: Enable Muse as Default Runner (`as_runner_model`)

If you want all regular prompts entered in the terminal to automatically coordinate with Muse without typing `/muse` every time, enable runner mode:

```bash
/muse config as_runner_model on
```

(Or via non-interactive command: `superagent muse config as_runner_model on`).

When enabled:
- Any message you type in the terminal is dispatched directly to Muse over Telegram.
- The input border indicator displays `COMM_LINK: MUSE REMOTE RUNNER`.
- The status bar displays `(Muse Remote)` next to the active model name.
- All slash commands (such as `/model`, `/clear`, `/exit`, `/muse status`) and system commands (`!<cmd>`) continue to work normally.
- To disable and revert to local model execution: `/muse config as_runner_model off`.

---

## 5. Remote Assistant (Muse) Setup Prompt

The remote assistant does not need any specialized client binary installed. Any AI assistant with access to Telegram Bot API (using Bot A's token) can act as Muse by using the system prompt below. Replace all `<...>` placeholders with your values before providing it to the remote assistant.

```text
You are Muse, the remote brain in an agent-to-agent coding setup. A local runner ("superagent") on the user's machine executes tools for you; you do the reasoning. You communicate only through a private Telegram group via Bot API long polling.

Identities:
- Bot A (you): <BOT_A_USERNAME>, id <BOT_A_ID> — poll its getUpdates exclusively (call deleteWebhook first; one token, one poller).
- Bot B (superagent): <BOT_B_USERNAME>, id <BOT_B_ID> — you never have its token.
- Group: chat id <GROUP_ID> (both bots are admins, Bot-to-Bot Communication Mode enabled).

Protocol — JSON envelopes, v: 1:
- task_request (in): {"v": 1, "kind": "task_request", "id": "task_<uuid>", "session": "<id>", "task": "<prompt>", "workspace": "<path>", "tools": [...], "context": [{"role": "user"|"assistant", "content": "..."}]}
- task_batch (out): {"v": 1, "kind": "task_batch", "id": "batch_<uuid>", "task_id": "task_<uuid>", "calls": [{"id": "c1", "tool": "read", "args": {"path": "src/index.ts"}}]}
  Tools available: read, glob, grep, ripgrep_search (safe); write, edit, write_to_file, replace_file_content, apply_patch (destructive — local runner prompts user).
- task_result (in): {"v": 1, "kind": "task_result", "id": "batch_<uuid>", "task_id": "task_<uuid>", "results": [{"id": "c1", "ok": true, "output": "<string>"}]}
- task_done (out): {"v": 1, "kind": "task_done", "task_id": "task_<uuid>", "summary": "<final markdown summary>"}
- chat (either): {"v": 1, "kind": "chat", "task_id": "task_<uuid>", "text": "<non-tool progress note>"}
- session_reset (in): {"v": 1, "kind": "session_reset", "session": "<id>", "message": "<reason>"}
- task_cancel (in): {"v": 1, "kind": "task_cancel", "task_id": "task_<uuid>", "reason": "<string>"}

Rules:
1. Process only messages where chat.id == <GROUP_ID> AND from.id == <BOT_B_ID>; ignore everything else.
2. Dedupe by envelope id and Telegram update_id — never answer the same batch twice.
3. ALWAYS send responses as Telegram replies to Bot B (use reply_parameters or reply_to_message_id) so Telegram routes messages even if Group Privacy Mode is enabled.
4. Loop: task_request -> reason -> task_batch -> wait task_result -> repeat -> task_done. Max 50 batches / 30 min per task.
5. Telegram message text limit is 4096 chars — split larger envelopes as: MUSEBUS <envelope_id> <n>/<N>\n<chunk>.
6. Prefer read-only batches first (explore before modifying). In task_done, format summary with clear newlines (\n), structured bullet points (-), and numbered items (1., 2.) so it is readable and well-spaced in the terminal.
7. Session Memory & Context: Multi-turn tasks maintain the same "session" identifier. Previous conversation turns are provided in "context". When a "session_reset" envelope arrives or a new session begins, wipe previous working memory and start fresh.
8. Task Cancellation: When a "task_cancel" envelope arrives for a task, immediately cease all work and planning on that task. Do not send further tool batches for it.
```

---

## 6. Protocol Reference

| `kind` | Direction | Description |
|---|---|---|
| `task_request` | Superagent -> Muse | Starts a task with goal, workspace, tools, and multi-turn context |
| `task_batch` | Muse -> Superagent | Dispatches a batch of tool calls to execute on local machine |
| `task_result` | Superagent -> Muse | Returns batch execution results with outputs or errors |
| `task_done` | Muse -> Superagent | Marks task completion with final user-facing summary |
| `chat` | Bidirectional | Out-of-band progress notes or chat text |
| `session_reset` | Superagent -> Muse | Resets remote assistant working memory when starting a new session |
| `task_cancel` | Superagent -> Muse | Cancels an ongoing task, ordering remote brain to cease immediately |

### Message Chunking Format
Any envelope whose JSON representation exceeds ~3800 characters is split into multiple parts using the `MUSEBUS` header:

```text
MUSEBUS <envelope_id> 1/<total_parts>
<chunk_data_1>
```

```text
MUSEBUS <envelope_id> 2/<total_parts>
<chunk_data_2>
```

Superagent's `EnvelopeReassembler` buffers incoming parts and reconstructs the envelope once all parts arrive (incomplete assemblies expire automatically after 5 minutes).

---

## 7. Troubleshooting

| Symptom | Cause | Solution |
|---|---|---|
| `Remote agent (Muse) is not configured` | Missing one of `botToken`, `groupId`, or `museBotId` | Set all three values using `/muse config <key> <val>` |
| `Failed to send task request` | Bot B token is invalid or Bot B was removed from the group | Check members list in Telegram and verify token via `/muse status` |
| `task_request` sent but no response | Bot-to-Bot Communication Mode is disabled on Bot A or Bot B | Enable mode in @BotFather Mini App (step 3.2) |
| Muse sends batch but Superagent doesn't respond | Group Privacy Mode is enabled on Bot B, blocking standalone messages | In @BotFather: `/setprivacy` -> Bot B -> `Disable`, or have Muse reply directly to Bot B's message |
| Group ID rejected or messages not arriving | Missing negative sign on group ID | Telegram group IDs must be negative (e.g. `-100...`) |
| Bot ID mixed up with Group ID | Group ID is negative; bot user ID is positive | Swap the values in `/muse config` |
| Telegram 409 Conflict | Another process is polling the same bot token | Ensure only one Superagent instance polls Bot B |

---

## 8. Security & Guardrails

1. **Token Protection**: Bot tokens are saved locally in `~/.superagent-r/remote-agent.json` and automatically masked in all UI and CLI outputs. Config files are gitignored.
2. **Permission Prompts**: Destructive file operations (`write`, `edit`, `apply_patch`, terminal commands) require interactive user approval. They are never auto-approved.
3. **Sender Authorization**: Superagent only executes batches from the configured `museBotId` inside the configured `groupId`. All other messages are discarded.
4. **Loop Protection**: Tasks automatically abort after 50 batches or 30 minutes to prevent infinite loops.
5. **No Token Collision**: Bot A and Bot B must use separate tokens so long-polling connections do not conflict.
