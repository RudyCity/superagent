# Phase 5l — operator-gated isolated Core recovery canary

Phase 5l adds the *first executable* operator recovery step, but it is an **isolated new-generation canary**, not full restoration or a production handover. It never overwrites the original Core port, imports sessions or chat turns, invokes a model, replays tools, installs Windows tasks or restarts external channels.

## Prerequisites and safety

Use only while the original Core is offline and after examining the Phase 5g/5k reconciliation report. Create and safeguard the PRIVATE offline evidence as described in docs/guides/core-phase5e-evidence-and-reconnect.md. This evidence may contain bearer tokens and chat content; never upload it to Git or share it.

Run the read-only safety assessment first:

    superagent core boot-audit --port 7888
    superagent core reconcile --snapshot "FULL_PRIVATE_EVIDENCE_FOLDER"
    superagent core recovery-cases --snapshot "FULL_PRIVATE_EVIDENCE_FOLDER" --limit 100 --offset 0

Review all pages of recovery-cases. Outstanding external side effects are **not** verified by any summary status, including "completed". Acknowledging cases does not authorize replay.

## Preview the isolated recovery execution

Select a fresh unused alternate local port, not 7888 and not the original Core port.

    superagent core recovery-canary --snapshot "FULL_PRIVATE_EVIDENCE_FOLDER" --target-port 59090

This preview verifies snapshot integrity, the original checkpoint schema, the original authenticated Core's offline status, absence of an unknown listener, unchanged original checkpoint/discovery/guardian bytes and receipt hashes, and that the target loopback port is free. It returns canaryStarted=false, approvalRequired=START_ISOLATED_CANARY and productionHandoverAuthorized=false. Preview sends no process signals and creates no new Core worker.

## Explicitly run a temporary, isolated canary

Only after reviewing the preview, use the EXACT approval phrase:

    superagent core recovery-canary --snapshot "FULL_PRIVATE_EVIDENCE_FOLDER" --target-port 59090 --approve START_ISOLATED_CANARY

The command creates a NEW local profile under ~/.superagent-local-staging/core-approved-canary-* with its own private checkpoint, separate auth token and empty chat history. Provider credentials and unrelated channel secrets are removed from its environment. It spawns an owned supervisor and worker on the alternate loopback port, confirms the authenticated discovery PID, Core port and readiness, then rechecks the original Core and source evidence. Finally, it stops only its own spawned canary process tree and reports whether termination was observed.

If readiness, ownership or termination cannot be verified, the command **fails closed**. It does not change the original snapshot, Core checkpoint or session affinity, and does not attempt an automatic production replacement. Temporary staging files may remain for forensic review. Do not use the canary to serve actual user traffic.

## Validation

    bun run build
    bun scripts/verify-core-approved-canary.ts
    bun scripts/verify-core-recovery-5g-j.ts --cycles 2

The dedicated smoke uses its OWN generated fake source checkpoint, temporary SQLite profile, random loopback ports, and explicit approval phrase; it validates a real child supervisor/worker without connecting to production model/API, MCP OAuth, Muse or Telegram. The local CLI executable is only used for an isolated worker with a new profile. Report files under ~/.superagent-local-staging are sensitive local diagnostics, not release certificates.

## Not yet delivered

- Actual operator-signed, auditable transaction ledger of individual external tool effects. No old-side-effects "exactly once" guarantee.
- Cutover to the original production Core port or recovery of LLM/subagent in-memory state. Old session IDs remain unavailable after all original workers die until independently verified recovery.
- Windows Service manager installation, full reboot recovery, real installed T-Line Tauri E2E, and 24–72 hour soak certification.
- The remote GitHub Actions run is not verified.

Therefore a successful canary is NOT permission to clear the old checkpoint or automatically restart prior chats.
