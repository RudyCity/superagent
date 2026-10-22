# SuperAgent RMemory Optimization v2 — P0–P2 Implementation

Date: 2026-10-22
Workspace: `D:\backup from pc asus\Documents Development\superagent`
Branch: `main`

## Scope and outcomes

This implementation extends the earlier RMemory reliability hardening without resetting the user's memory, changing the installed embedding provider, or overwriting unrelated concurrent work.

### P0 — Security, retrieval quality and recovery

1. **Scoped retrieval** (`src/core/memoryRetrieval.ts`, `src/core/rmemoryUtil.ts`): use reciprocal rank fusion for the project/global/legacy candidate lists; enforce project scope and trusted legacy markers, explicit assertion conflict blocking, lifecycle eligibility and identical-content deduplication before selecting the top K. Do not compare raw distance scales between retrieval lists.
2. **History isolation** (`src/core/rmemoryUtil.ts`, `src/core/tools/rmemoryTools.ts`, `src/core/historySearch.ts`): `searchConversation` requires a project ID and postfilters backend results. The L0 search tool rejects `projectOnly=false`; switching to an authorized workspace is required for another project's history. The history-search path now uses canonical hashed session keys.
3. **Fresh bootstrap context** (`src/core/agent/HistoryCompactor.ts`): new memory contexts store a hashed query marker. When a user's subject changes, recall can rebuild the memory context and replace the prior block instead of stacking duplicates. Legacy restored contexts without a query marker are preserved conservatively.
4. **Pre-storage secret redaction** (`src/core/rmemoryUtil.ts`): redact recognized API keys, tokens, connection strings and private keys before embedding/persisting new L0/L1 memory. Legacy records are not automatically rewritten.
5. **Archived-index recovery** (`src/core/memoryArchiveRecovery.ts` and `rmemory_archive_recovery`): `list` and `preview` inspect old `.index-backups/backup-*` SQLite data read-only. Apply requires exact preview fingerprint and interactive owner confirmation, selectively re-embeds up to 250 clearly scoped atomic memories per batch, skips existing IDs and retains source backup. It does not automatically restore ambiguous memories or archived raw conversations.

### P1 — Performance, memory intelligence

1. **Incremental history backfill** (`src/core/historySearch.ts`): v2 registry tracks per-session prefix fingerprint and message count. Append-only sessions send new messages only; edited sessions safely recheck their entire history. Crash retry is protected by stable content IDs.
2. **Shared local extractor and embeddings cache** (`src/core/rmemoryUtil.ts`): single-flight ONNX model loading with a two-model bound; SHA-256-keyed, capped 512-entry in-process embedding vector LRU; batch duplicate elimination and bounded embedding batches. No query text stored as a cache key.
3. **Conservative memory candidate discovery** (`src/core/memoryIntelligence.ts`, `rmemory_suggest`): recognizes explicitly labeled decisions, preferences, facts and task summaries; skips credentials and duplicate assertions. Returns `candidate` records for review only; never writes or marks verified without an explicit separate owner action.

### P2 — Context budget and observability

1. **Adaptive recall budgets** (`src/core/memoryBudget.ts`, `HistoryCompactor.ts`, `RMemoryStrategy.ts`): bounded by configured prompt budget and adjusted for query complexity.
2. **Safe process-local metrics** (`src/core/memoryTelemetry.ts`): search count and results, latency p50/p95, cache hits, ingested and duplicate-skipped counts. `rmemory_status` returns metrics and the CLI settings panel shows query/cache summaries. No raw queries, prompt text or secrets are retained in telemetry.
3. **Offline benchmark** (`scripts/benchmarkRmemoryV2.ts`): check ranking and scope governance deterministically against the versioned labeled fixture.

## Operator workflows

RMemory tools available to owner-tier agents:

- `rmemory_status`: read local health, embedding model, and performance counters.
- `rmemory_suggest`: preview reviewable candidate memories from supplied text; no automatic persistence.
- `rmemory_archive_recovery action=list`: list archive backups.
- `rmemory_archive_recovery action=preview archive=<name> limit=50`: show reviewed scoped candidates and fingerprint.
- `rmemory_archive_recovery action=apply archive=<name> fingerprint=<exact fingerprint> limit=50`: requires interactive confirmation and re-embeds only missing scoped records.

Run the offline ranker benchmark: `bun scripts/benchmarkRmemoryV2.ts`.

Run focused tests: `bunx vitest run tests/rmemoryUtil.test.ts tests/rmemoryRecovery.test.ts tests/rmemoryTools.test.ts tests/rmemoryHistorySync.test.ts tests/rmemoryOptimizationV2.test.ts tests/RMemoryStrategy.test.ts tests/useRmemoryStatus.test.ts tests/memoryRecallEvaluation.test.ts tests/memoryLifecycle.test.ts tests/memoryRetentionSweep.test.ts tests/memoryWriteTierGuard.test.ts tests/compactionReliability.test.ts tests/historyCompactorMemory.test.ts tests/skillLearningMemoryAdapter.test.ts --maxWorkers=2 --reporter=dot`.

Build: `bun run build`.

## Verification and limitations

- **14 test files, 117 tests passed** (focused RMemory and adjacent skill-learning regressions).
- **Bun 1.4.2 build passed**; no generated artifacts were intentionally committed.
- **3 offline ranker cases** in the versioned fixture: recall@5 = 100%, precision@5 = 100%, cross-project leakage = 0. This is **not** production end-to-end embedding recall, nor a statistically meaningful search-quality estimate.
- Real indexed production throughput, multi-process concurrent vector writes, RAM savings, or full archive re-embedding at scale are **not yet demonstrated**. Run a disposable-data end-to-end validation before declaring production readiness.
- Archived model restoration is guarded and interactive; encrypted or modified nonstandard legacy schemas may require a reviewed migration. Source backup files must not be deleted automatically.
- No user memory reset, no automatic archive mutation or restore, and no forced change to an existing `enableRmemory` setting.
- RMemory optimization changes coexist with many unrelated local uncommitted changes on `main`. No Git commit or push is included in this work.

## Recommended next release gate

Use a dedicated disposable `~/.superagent-r`-compatible data directory, run simultaneous Bun CLIs against a seeded test index, execute the confirmed archive migration in that isolated environment, measure cold/warm latency, RSS and recall over a larger multilingual labeled dataset, and obtain owner approval before migrating actual user memory.
