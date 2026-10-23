# SuperAgent — Bun-Native Runtime Migration

Date: 2026-10-22
Repository: RudyCity/superagent, branch `main`
Target: Bun 1.4.2+ for all first-party JavaScript/TypeScript runtime paths.
Related T-Line work: T-Line v1.3.699 already bundles Bun and passes `TLINE_BUN_RUNTIME`.

## Implemented

- CLI source and emitted `dist/cli.js` use `#!/usr/bin/env bun`. CLI rejects Node/older Bun instead of silently entering a different SQLite/worker runtime.
- `bun run dev`, `bun run build`, `bun run start`, schema sync, extension verification, wiki scripts and test scripts use Bun. Vitest is invoked using `bun --bun x vitest` so the test runner itself uses Bun, not just npm-script orchestration.
- `package-lock.json` (old npm install graph) removed. `bun.lock` is the canonical lockfile; frozen lockfile dry run passed.
- MCP/Antigravity registration uses the current absolute Bun executable, not `node`; Windows paths remain JSON-safe. Old IDE MCP config requires re-registration after deploying the new version.
- Detached Motion Studio workers and RMemory gateway/history-sync tasks reuse the invoking Bun binary. Bun handles TS workers directly; no `--import tsx` Node hook required.
- RMemory installer/build helper uses Bun, and tunnel client global package installation uses `bun add -g`. Binary discovery includes Bun global shims in `~/.bun/bin`.
- Playwright screenshot tool uses Bun's package executor. Bundled codebase-wiki watcher uses Bun for recursive child invocations instead of shell-interpolating a `node` command.
- Newly generated minimal project templates now use Bun.
- Smoke scripts exercise CLI compiled artifact without Node/npm PATH, Bun OS process workers, `bun:sqlite` and the pinned `r-memory` package's Bun SQLite adapter, plus an ephemeral local API server separately.

## Verification

- `bun run build`: passed; MCP Chrome schemas synchronized.
- `bun run runtime:smoke`: passed (Bun CLI, ProcessPool worker, Bun SQLite, RMemory initialization with temporary DB).
- `bun --bun x vitest ...`: 11/11 MCP and worker-focused tests passed. The broader eight-file Motion/Startup/RMemory set passed 50/50 using standard Vitest. In Bun-runtime Vitest mode, an initial Motion supervisor test revealed a scheduling race in the assertion; the test was updated to observe a real cycle before abort, and the full selected eight-suite set now passes 50/50.
- `bun install --frozen-lockfile --dry-run`: passed before the final no-dependency script changes; revalidate after final changes as needed.
- Full codebase test suite was attempted but did not finish inside the tool execution window; do not claim it all passed.

## Scope / honest limitations

- Node.js is **not required to start SuperAgent's own CLI/server, workers, MCP, or memory adapters** after this migration. Built-in `node:` module specifiers remain because Bun deliberately implements Node compatibility APIs.
- External user-selected MCP servers, npm packages, cloud tunnel binaries, custom CLI agents, Python services, Chrome/Playwright browsers and other third-party tools can retain independent runtime requirements. This migration does not rewrite or upgrade all such unrelated projects.
- The `r-memory` dependency exposes its own `bun:sqlite` path. Directly importing `better-sqlite3` fails in this environment, but runtime RMemory database initialization under Bun was verified using a disposable SQLite file. Do not switch an existing database driver on disk without explicit data migration.
- Existing running SuperAgent sessions were not restarted; they keep their original runtime until the next deliberate restart/upgrade.
- Test process used an isolated temp home and ephemeral ports; no existing SuperAgent listener (such as 7888) was killed or modified.
- This commit does not include concurrent changes to agent ContextBuilder/HistoryCompactor, CLI Bridge, Motion effects, or untracked Gumroad assets.

## Completion update — Bun-only first-party launches (2026-10-22)

- The CLI now rejects Node rather than bootstrapping Bun through a Node parent. The first-party global Windows npm shims (`superagent`, `.cmd`, `.ps1`) were backed up and replaced with Bun-native launchers using `bun run repair:launcher`. `bun run doctor:launcher` verifies them; Git Bash MSYS path conversion was explicitly tested. CMD, PowerShell, and Git Bash each returned SuperAgent 1.14.11.
- The persisted Antigravity MCP registration was replaced with the absolute Bun executable (`bun dist/cli.js mcp register`); already-running MCP clients must reconnect separately. Do not terminate historical Node bootstrap parents or active Bun children blindly.
- Bun-native tests: `bun run build`, `bun run runtime:acceptance`, `bun run integration:tline` and launcher/MCP tests passed. The Bun security gate reported zero high/critical advisories at the final check; audit outcomes can change later.
- The separately maintained T-Line Desktop 1.3.699 now uses Bun for first-party build scripts, Vite/TypeScript/Vitest, and the Tauri JavaScript CLI entry. The unused `node-pty` dependency and ignored legacy `desktop-tauri/node-runtime` directory were removed. T-Line Bun backend/ConPTY smoke, packaged NSIS extraction/backend authentication and targeted backend/frontend tests passed. A real installed GUI, tray and WebView2 end-to-end session is still a distinct verification gate.
- `node:` import specifiers do not mean the Node runtime is in use. External user-selected CLI/MCP servers and Python Vision/voice/FFmpeg/Rust tooling continue to use their required independent runtimes and must not be silently altered.
- Source changes in multiple unrelated workstreams were active concurrently. Do not stage or commit those unrelated modifications under the Bun migration without a targeted review.

## Final concurrent-work constraint

The additional isolated Bun API-server smoke passed: the server started with Bun on an ephemeral loopback port and its protected API returned HTTP 401. The canonical lockfile dry run also passed. The final global TypeScript build was **not green** because another active development task concurrently modified Motion Studio/CLI Bridge files outside this migration. Its latest error was `src/core/commands/motionCliHandler.ts: EffectCatalogItem.complexity` (earlier the CLI Bridge declared a `lease` variable twice). Those files were not altered, staged or repaired by this Bun migration. After the concurrent tasks settle, rerun `bun run build` and the complete Vitest suite before approving production.
