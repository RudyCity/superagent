# RMemory reliability hardening — 2026-10-22

Scope: SuperAgent `main`; local `r-memory` index, history backfill, compaction, diagnostics, and regression tests. Existing user memories must not be erased automatically.

## Implemented

- The local `MemoryClient` no longer requires an unrelated HTTP gateway API key; embedding-provider authentication remains separately enforced when configured.
- Conversation messages use SHA-256 physical identities based on project, session, role, timestamp, and content (or an explicit stable messageId). Writes check for already-persisted rows before embedding and before insertion; clashes with conflicting metadata fail closed.
- Conversation ingestion now embeds and writes in bounded batches of eight, not an unbounded accumulated vector array. Retrying after a partial failure can safely resume.
- `getRMemory()` initialization uses a process-local single-flight promise and a cross-process `.index-init.lock`, preventing simultaneous Bun processes from migrating the same SQLite index.
- Backfill loads each historical session's **persisted working directory** and **persisted history path**; unknown workspace identity is intentionally skipped. The registry is version 2, keyed per session/project and based on a full-content fingerprint; appended messages and legacy registry entries are rechecked.
- Backfill is protected by an exclusive PID lock. Already-running jobs are not duplicated and old abandoned locks can be recovered. Registry changes use a temporary file and atomic rename. Per-session errors do not stop remaining sessions.
- Changing the embedding model or dimensions retains previous index files and their original metadata in `~/.superagent-r/rmemory/.index-backups/backup-*`. These archives are **not** loaded by the new model automatically; deliberate re-embedding or restore is required to make old vectors searchable again. Rollbacks still restore staged artifacts.
- RMemory TUI status distinguishes disabled/uninitialized/ready/degraded using actual diagnostics rather than equating `enableRmemory` with availability.
- Compaction recall redacts common secret formats, limits persona/scenario snippets and overall memory context size, and explicitly treats retrieved content as untrusted reference data, never as instructions or permissions.
- Session-history timestamps on the incremental sync boundary are included on both sides to avoid missing messages that share a millisecond; deterministic IDs eliminate repeat storage.
- Existing `memory sweep` and daemon retention entry points remain non-destructive: retention changes eligible metadata, not underlying records.

## Verification

- `bunx tsc --noEmit --pretty false`
- `bunx vitest run tests/rmemoryRecovery.test.ts tests/rmemoryHistorySync.test.ts tests/rmemoryUtil.test.ts tests/RMemoryStrategy.test.ts tests/useRmemoryStatus.test.ts ...`
- Tests cover scoped backfill, unchanged/updated sessions, missing project identity, a live lock, deterministic IDs, idempotent retries after partial failure, single-flight initialization, old-index backup survival, and health-status rendering.

## Deployment and operator notes

1. Back up `~/.superagent-r/rmemory/` and configuration before switching embedding models.
2. RMemory is not automatically enabled by this change; respect the owner’s existing `enableRmemory` setting. Enabling a cold local embedding model may require a model download.
3. To inspect health: `rmemory_status` or the CLI settings view. An enabled but uninitialized index should read `checking` / `NOT INITIALIZED`, not online.
4. To sync historical sessions: `bun src/cli.tsx --sync-history-only` (requires RMemory enabled). Run once; the new registry skips unchanged sessions on later runs. Missing project paths are skipped rather than indexed globally.
5. To preview memory retention: `bun src/cli.tsx memory sweep`; `--apply` only updates lifecycle metadata.
6. A model-switch backup can be inspected under `.index-backups/`; do not delete it unless old data has been explicitly recovered or re-embedded. Do not copy an old-dimension DB into an active new-dimension index.
7. Existing already-duplicated legacy message rows are intentionally not deleted; new writes are deduplicated. Any cleanup must use a reviewed, backed-up migration.
8. Existing long-lived CLI processes need restart to load the updated source. A separate CLI started with old code remains old until restarted.

## Residual / validation boundaries

- This patch does not migrate or re-embed archived old-model vectors automatically. A deliberate backup-aware migration tool would be required.
- Production embedding throughput, disk use, model download, and cross-process SQLite concurrency are not established by mocked tests. Validate using a disposable, non-production RMemory data directory before enabling at scale.
- Model initialization and history backfill use inter-process locks. Cross-process lock recovery and concurrent live SQLite writers still require integration validation against disposable RMemory storage.
- This work does not enable, reset, delete, or merge any owner data automatically.
