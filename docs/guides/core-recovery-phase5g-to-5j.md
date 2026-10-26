# Recovery Phase 5g–5j: safe implementation and acceptance

**Scope:** SuperAgent API Core and independent T-Line front door. The implementation is a set of operator safety gates, lifecycle/channel policies and bounded chaos tests. It is NOT proof of unattended full-machine reboot recovery, agent-memory serialization or persistent third-party OAuth connection transfer.

## 5g — cold-start reconciliation

1. If Core is offline, inspect with: superagent core boot-audit --port 7888
2. Only while the original Core owner and foreign listeners are absent, take a private snapshot: superagent core evidence-snapshot --port 7888. Keep the printed folder confidential: it contains bearer credentials and chat history, while the reconcile report excludes sensitive data.
3. Run: superagent core reconcile --snapshot "FULL_LOCAL_PATH_PRINTED_BY_SNAPSHOT_COMMAND". This reads only a verified snapshot under the current owner's ~/.superagent-r/recovery-evidence folder, checks SHA-256 against metadata and SQLite, checks SQLite integrity, counts saved sessions, groups turn states and flags unknown/incomplete work. It rejects altered or authorization-spoofed manifests and symlink files.
4. The report always sets restartAuthorized=false, toolsMayReplay=false, requiresExternalEffectReview=true and requiresHumanOperatorReview=true. There is no --force, no deletion of checkpoint/lease/receipt and no automatic tool replay. Even a completed chat turn does NOT prove an external side effect was applied exactly once.

This deliberately does not release the Core boot fail-closed barrier on stale sessions. Full cold-start restoration from dead workers remains pending.

## 5h — Windows lifecycle boundaries

Run: superagent core lifecycle-plan. This previews the owner-scoped startup/shutdown ordering for T-Line front door, channel host, Core Guardian and supervisor. MCP tunnel, Muse and Telegram are independent.

The evaluator src/core/runtime/coreServiceLifecycle.ts requires verified local ownership and at least three consecutive health failures before it suggests a guarded Core recovery. Any checkpoint/side-effect blocker requires operator review. MCP, Muse and Telegram remain outside Core lifecycle signals. The evaluator sends no signal and registers no task.

The existing opt-in Windows login task generator scripts/setup-core-windows-startup.ts remains preview-only without --apply. It still launches Core boot with fail-closed dead-worker handling. An installed all-service lifecycle manager is NOT included.

## 5i — independent channels and agent state

src/core/runtime/coreChannelRecovery.ts forbids implicit adoption of MCP OAuth, Muse and Telegram sessions. An already connected channel is retained only if its original identity is verified. Lost credentials require reauthentication/operator review. Stopped transports only get read-only probes.

A T-Line/web-chat explicit session resume is a candidate only with verified original channel owner, zero ambiguous executions, saved durable history and explicit user approval. The server still independently revalidates receipt/workspace/history. No model/tool POST is replayed. In-flight LLM state, subagent live memory and OAuth connections are not reconstructed by this phase.

## 5j — hardening, chaos and bounded staging cycles

Build and verify locally:

    bun run build
    bun scripts/verify-core-recovery-5g-j.ts --cycles 2

The --cycles parameter is limited to 1–5. Each cycle executes the Phase 5d/5e/g-j fault-matrix unit suite. The harness then runs the existing isolated process-level Guardian/Core/T-Line crash test and dead-worker session resume test once. These own their staging homes, listeners and subprocesses. Report is saved locally under ~/.superagent-local-staging. No model/tool, external notification, other tunnel or production process is intentionally touched.

Still NOT certified: 24–72 hour real uptime soak, live Windows reboot with agent workload, native installed T-Line Tauri E2E, cross-version migrations, RAM/PID resource leak benchmarks, full channel OAuth reconnect, exact-once side-effect accounting and remote GitHub CI. Those require a dedicated maintenance/staging environment.

## Security

- Never share recovery-evidence backup folders. Files contain private credentials and chat content even though manifests omit these contents.
- Never delete or rename a checkpoint because a PID lookup failed; Windows may reuse PIDs.
- Never retry unknown-outcome side-effecting tool/chat calls automatically.
- Do not install OS startup tasks or restart MCP/Muse/Telegram without explicit operator control.
