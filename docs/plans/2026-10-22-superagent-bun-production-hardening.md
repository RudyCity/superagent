# SuperAgent Bun production hardening — 2026-10-22

## Scope
SuperAgent-owned CLI, API server, memory/SQLite, process pool, motion jobs, MCP and T-Line protocol are already Bun-native. Third-party commands (MCP servers, AGY, Python Vision) may need independent runtimes and must never be silently rewritten.

## Changes
- Redact privileged API token from console and persisted server diagnostic logs.
- Atomically replace per-port and current-server discovery token files with best-effort owner-only permissions.
- Synchronously remove the current PID mailbox on process exit (async import cannot finish reliably).
- Add repeatable synthetic Bun performance benchmark (5 CLI launches, four 16-file process-pool batches, p50/p95 and RSS).
- Add strict Bun dependency audit release gate: high/critical advisories or unavailable registry blocks approval.
- Add Windows and Linux GitHub CI runtime matrix using Bun 1.4.2 and independent security check.

## Acceptance criteria and blockers
- Build/isolated acceptance verifies CLI, Bun worker, bun:sqlite, RMemory and loopback API.
- Existing SuperAgent server on port 7888 is unverified by T-Line; its normal per-port discovery token file is absent. Do not terminate/hijack that process.
- High-severity advisories in the installed dependency graph remain a production release blocker; Bun runtime compatibility alone is not evidence of patched packages.
- Full-suite flaky WebSocket and tool-discovery tests require isolated reproducibility and targeted fixes; pass counts on unrelated suites do not imply 100% regression acceptance.
- Actual desktop installer, tray, WebView2 and T-Line live agent task still require clean Windows E2E.

## Additional validated contracts
- Isolated T-Line bridge integration boots SuperAgent on a random loopback port, verifies an authenticated ping and rejects wrong or absent bearer tokens. It never uses live port 7888.
- Bun lifecycle smoke verifies PID mailbox and journal cleanup when an isolated worker exits.
- Focused regressions cover ProcessPool, mailbox, server auth, MCP registration, Muse WebSocket and tool discovery.
- The dependency security gate fails on unresolved high advisories. Never disable the check to claim production approval.
