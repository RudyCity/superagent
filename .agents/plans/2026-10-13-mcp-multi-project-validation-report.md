# MCP / Multi-Project Isolation Validation — 2026-10-13

## Scope and baseline
- Workspace: `D:\\backup from pc asus\\Documents Development\\superagent`
- Branch / starting HEAD: `main` / `f7c7c571`
- No commit or push performed.
- Goal: validate MCP session/workspace routing, chain request context, abort session scoping, and address test failures that appeared during the full suite.

## Fixes made
1. `tests/setup.ts`: remove inherited `SUPERAGENT_SESSION_PATH` so an interactive parent session does not inject its active task artifacts into child CLI bridge tests. Tests covering the environment variable explicitly set it themselves.
2. `tests/server2.test.ts`: update the no-session `POST /api/abort` test to assert the current safe contract (HTTP 400 when there is no matching session) instead of the stale HTTP 200 expectation. Existing scoped-abort tests remain in place.
3. `tests/agentPayloadTooLargeRetry.test.ts` and `tests/contextLengthExceededRetry.test.ts`: use unique temporary workspaces for Agent retry tests instead of the live repository. This prevents working-tree diff contents from modifying mocked model output and causing false extra retries. Restore the runner's original CWD after tests; keep the temp workspace until process exit to avoid Windows EPERM when an Agent is still using that directory.
4. `src/core/setup/pdfOcrEngine.ts`: stat-check the PDF path before launching the Python OCR script, and fail immediately with a clear error for missing/non-file paths.

## Validation results
- `bun run build`: PASS (TypeScript compile).
- `git diff --check`: PASS (only Git's normal Windows LF-to-CRLF notices).
- MCP/session/workspace/chain focused group (10 files, including `abortScope.test.ts`): PASS, 66/66.
- Changed/regression test group (`agentPayloadTooLargeRetry`, `contextLengthExceededRetry`, `cliBridgeTool`, `server2`, `pdfOcr`): PASS, 141 passed, 3 skipped, 0 failed.
- The full suite comprises 305 test files and was run in 8 Vitest shards because a single full invocation exceeded the connector runtime. Final successful shard results:
  - 1/8: 39 files, 492 passed.
  - 2/8: 38 files, 301 passed.
  - 3/8: 38 files, 345 passed, 1 skipped.
  - 4/8: 38 files, 308 passed.
  - 5/8: 38 files, 401 passed (re-run after flaky failure).
  - 6/8: 37 passed files + 1 skipped file; 334 passed, 1 skipped (re-run after OCR fast-fail fix).
  - 7/8: 38 files, 429 passed, 3 skipped.
  - 8/8: 38 files, 410 passed (re-run after context retry test isolation fix).
- Aggregate shard counts: 3,020 passed, 5 skipped, no failing assertions in the final shard runs. Changed test files were also run together after the last cleanup changes.

## Notes / remaining limitations
- MCP tunnel reports ACTIVE, but currently 0 external MCP clients are connected. Automated multi-session/workspace routing tests passed; a live two-client external MCP session test could not be performed with no connected clients.
- Some passing shard runs emitted non-fatal SQLite mirror warnings from `fileLocksDb.replaceAllLocks` (unique-file-path conflict / database already closed) during asynchronous best-effort lock mirroring. This run did not establish a failing assertion from those warnings; they remain a follow-up investigation item.
- Full-suite sharding and targeted test groups completed successfully, but no single monolithic `bun run test` command was used due connector timeout behavior.

## Files changed
- `src/core/setup/pdfOcrEngine.ts`
- `tests/agentPayloadTooLargeRetry.test.ts`
- `tests/contextLengthExceededRetry.test.ts`
- `tests/server2.test.ts`
- `tests/setup.ts`

## Git
- Changes remain uncommitted on `main`.
- No push performed.
