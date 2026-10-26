# Phase 5k — per-session cold-recovery casebook and bounded Core observer

This phase adds operator-grade *read-only diagnostics* to the prior Phase 5g–5j safety gates. It does not provide auto-cold-restart, live agent state serialization, tool replay or OS task registration.

## Review one offline recovery snapshot, case by case

Take an offline snapshot only after confirming Core is not running, using the existing Phase 5e commands:

    superagent core boot-audit --port 7888
    superagent core evidence-snapshot --port 7888

The evidence-snapshot prints a private folder with credentials and chat data; protect it as a secret. After snapshot verification, use:

    superagent core reconcile --snapshot "FULL_PRIVATE_SNAPSHOT_FOLDER"
    superagent core recovery-cases --snapshot "FULL_PRIVATE_SNAPSHOT_FOLDER" --limit 100 --offset 0

The new recovery-cases command verifies the evidence manifest, metadata hashes and SQLite integrity before reading any case. It uses read-only SQLite queries of only session_id, state and counts, and reads scoped receipt identifiers. It never loads or prints messages, tool arguments, workspace paths, history text or bearers. Each session is reported by a truncated SHA-256 pseudonym (sessionRef), not the original session ID; a trusted operator can correlate this to their local session ID privately. Stable case ordering permits paging with --offset. nextOffset=null indicates the last page. A non-null nextOffset signals there are additional cases that must be reviewed. The maximum page size is 500 and the total inventory is bounded to 10,000; excessive data refuses partial inventory.

Each result indicates whether the durable session record and receipt are available, chat-turn state counts, review obligation and required actions. Cases with accepted, queued, running, interrupted, recoverable or unknown turns require explicit human review of side effects. Even cases with only completed turns are marked external_effect_review because no task state proves an external payment, file write, network call or other tool completed exactly once.

The tool always emits restartAuthorized=false, automaticReplayAllowed=false, externalEffectsReconciled=false and per-case resumeAuthorized=false. It cannot change the existing checkpoint or approve a replacement Core generation. A report is evidence for operator investigation, not an authorization grant. The earlier Core boot policy still rejects a completely dead worker generation with stale checkpoints.

## Inspect supervisor lifecycle without changing any service

    superagent core lifecycle-observe --port 7888 --samples 3

The observer uses three bounded, authenticated GET status calls with short pauses, requires the same supervisor PID and exact target port for all samples before declaring verified local control ownership, and emits a dry-run policy assessment. Dead, foreign or changing owners are unverified and require operator review. This command does not issue HTTP POST, kill PIDs, install scheduled tasks, start Core, open a model session, or touch any MCP/Muse/Telegram channel. The sample count is limited to 1..10. An online owner passing all samples is an observation only, not a clearance to restart or take over.

## Tests and release gates

    bun run build
    bun --bun x vitest run --maxWorkers=2 tests/coreRecoveryCasebookObserver.test.ts tests/coreRecoveryPhase5gToJ.test.ts
    bun scripts/verify-core-recovery-5g-j.ts --cycles 2

Dedicated tests exercise anonymization, paging without omission, missing durable history, tampered receipt digests, unverifiable owner identity, stable authenticated status and refusal to kill anything. The existing staging harness uses isolated loopback Core and T-Line processes, not production services. It does not constitute installed Tauri app acceptance, a 24–72h soak, full worker memory migration, unattended OS reboot restoration or authenticated reconnection of third-party OAuth sessions.

Docs from earlier phases: core-recovery-phase5g-to-5j.md, core-phase5e-evidence-and-reconnect.md and core-agent-session-recovery.md.
