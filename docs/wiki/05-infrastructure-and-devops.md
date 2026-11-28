# 05. Infrastructure, Storage & DevOps

This document details the filesystem layout, runtime configuration, build pipeline, and process management for Superagent.

---

## 1. Filesystem & Storage Topology (`~/.superagent-r/`)

Superagent isolates all user state, models, logs, worktrees, and databases in the user's home directory under `~/.superagent-r/`.

```text
~/.superagent-r/
├── history.db                     # SQLite database (single source of truth for all sessions & messages)
├── history.db-wal                 # SQLite Write-Ahead Log
├── history.db-shm                 # SQLite shared memory index
├── model-config.json              # Provider credentials, tier assignments, and system settings
├── superagent.log                 # Rolling process execution log
├── terminal-presets.json          # User-defined terminal execution shortcuts
├── worktrees/                     # Git worktrees allocated for Superagents
│   ├── auth-jwt/                  # Worktree directory for feature/auth-jwt branch
│   └── ui-dark-theme/             # Worktree directory for feature/ui-dark-theme branch
└── history/                       # Session workspace artifact directories
    └── multi/
        └── sess_1740000000000/
            ├── plan.md            # Master Agent implementation plan
            ├── task.md            # Bite-sized task breakdown
            └── walkthrough.md     # Verification walkthrough summary
```

---

## 2. Build & Packaging Pipeline

Superagent is written in TypeScript and compiled to standard CommonJS/ESM executable bundles:

```powershell
# Development live execution (via tsx)
bun run dev

# Full TypeScript compilation to dist/
bun run build

# Run all verification gates (TypeScript build, extension JS check, Vitest suite)
bun run verify:all
```

### Build Scripts in `package.json`

| Script | Command | Purpose |
|---|---|---|
| `dev` | `tsx src/cli.tsx` | Run CLI directly with TypeScript on-the-fly execution |
| `build` | `tsc` | Compile all `src/` TypeScript sources to `dist/` |
| `test` | `vitest run` | Run all test suites in `tests/` directory |
| `verify:extension-js` | `node scripts/verify-extension-js.mjs` | Validate Chrome extension bundle integrity |
| `verify:all` | `bun run build && bun run verify:extension-js && bun run test` | Full pre-commit release verification gate |
| `ext:css` | `tailwindcss -i chrome-extension/sidepanel.src.css -o chrome-extension/sidepanel.css` | Compile Tailwind CSS for Chrome Extension sidepanel |

---

## 3. Storage Rules & Constraints

1. **Zero `process.env` Rule**:
   - Environment variables (`process.env.OPENAI_API_KEY`, `process.env.MODEL`, etc.) MUST NEVER be read or written in production code.
   - All configurations are loaded through `src/core/config/jsonConfig.ts` and `src/core/config/providers.ts`.
2. **SQLite Transcript Storage**:
   - Transcripts must only be loaded via `loadSessionFromDb()` and saved via `saveSessionToDb()` in `src/core/storage/historyDb.ts`.
   - Never write conversation transcripts into `.json` session placeholder files.
3. **Worktree Directory Management**:
   - Worktree paths are automatically managed under `~/.superagent-r/worktrees/`.
   - Stale worktrees are automatically pruned via `gitWorktreeTool(action: "prune")`.

---

## 4. Logging & Diagnostics

Superagent writes two different logs. Confusing them is what makes an operator look at a terminal that was never supposed to receive the message.

| Log | Owner | Written by | Read by |
|---|---|---|---|
| `~/.superagent-r/superagent.log` | CLI process | CLI / agent / tool lifecycle events | `/doctor terminal`, incident review |
| `~/.superagent-r/superagent-server.log` | Core / server host | `src/core/utils/runtimeLog.ts` | SuperAgent Tray → Logs (source `server`), operators |

- **Log File**: `~/.superagent-r/superagent.log`
- Log format: ISO timestamp, process ID, execution tier (`[MASTER]`, `[SUPERAGENT]`, `[SUBAGENT]`), message severity, and payload.
- Error events are captured with full stack traces and sanitized before rendering user-facing error boxes.

### Runtime log contract: file first, terminal only on request

`src/core/utils/runtimeLog.ts` is the single source of truth for Core/server runtime messages. Every call goes through `serverRuntimeLog(level, ...args)`, which always appends exactly one `[LEVEL] message` line to `superagent-server.log`; the terminal copy is a separate, explicit decision.

| Host | Appends to log file | Echoes to terminal | Host reason |
|---|---|---|---|
| Interactive CLI (embedded server, `runServer(port, true)`) | ✅ | ❌ | `embedded host (CLI/Tray-owned/tunnel server)` |
| Supervised Core worker / Tray-owned / tunnel host | ✅ | ❌ | silent host |
| Foreground `superagent --server <port>` | ✅ | ✅ | `foreground server` |
| `superagent core start` in a terminal | ✅ | ✅ | `core supervisor terminal` |
| `superagent core start` with piped stdio (Tray/daemon) | ✅ | ❌ | `core supervisor piped stdio` |

Rules:

1. **Never replace `console` to silence runtime chatter.** A global wrapper also swallows CLI/REPL output (slash commands, tool progress, one-shot answers). Route the specific emission through `serverRuntimeLog()` instead.
2. **A host records its decision once** with `setRuntimeLogTerminalEcho(enabled, reason)`. The reason string is surfaced by `/doctor terminal`.
3. **Debugging override**: `SUPERAGENT_RUNTIME_LOG_ECHO=1` forces echo on, `0` forces it off, any other value falls back to the host decision. The override is reported with `source: env`.
4. **Tray coverage is unaffected** by echo: the file is written either way, and rotating is bounded at 5 MB.

