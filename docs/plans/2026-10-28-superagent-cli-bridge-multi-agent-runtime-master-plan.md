# SuperAgent CLI Bridge Multi-Agent Runtime — Master Implementation Plan

**Date:** 2026-10-28
**Project:** SuperAgent
**Primary runtime:** `superagent_cli_bridge`
**Target:** evolve CLI Bridge from a CLI wrapper/background-job runner into a safe, observable, resource-aware multi-agent execution runtime.

## 1. Current baseline and verified evidence

Existing foundations that MUST be preserved:

- `delegate.start` runs pollable background CLI jobs.
- Interactive `session.*` operations already exist.
- Host-wide numbered capacity slots already exist with atomic acquisition and owner tokens.
- Default host-wide capacity is currently **4 slots**.
- `idempotencyKey`, `expectedArtifacts`, timeout, cancel, retry, health, tail, read, and job persistence already exist.
- AGY permission modes already distinguish `accept-edits`, `plan`, `auto`, and `full-auto`.
- Job shards and persisted metadata already prevent one bridge process from overwriting another bridge process's jobs.
- Persistent parallel task primitives already exist separately in `assistantTaskStore` and `assistantTaskDispatcher`.
- Workspace/project access remains explicit and fail-closed.

### Live acceptance evidence on 2026-10-28

Two AGY delegations were started concurrently through:

`MCP -> superagent_cli_bridge -> AGY`

Observed:

- AGY A: separate PID, capacity slot 1, returned `AGY_PARALLEL_A_OK`.
- AGY B: separate PID, capacity slot 2, returned `AGY_PARALLEL_B_OK`.
- Both were in `running` state concurrently.
- Both completed successfully.
- During the run, all four capacity slots appeared occupied.
- Before the run, slots 0 and 3 were already occupied while 1 and 2 were available.

Therefore **parallel AGY execution is already real**, but stale/orphan capacity handling and scheduling are not yet production-grade.

---

# 2. Definition of done

CLI Bridge is considered a **Multi-Agent Execution Runtime v1** only when all of the following are true:

- [x] Stale capacity slots are automatically diagnosed and safely recoverable without PID-only deletion.
- [ ] Scheduler can select a safe concurrency value between 2 and 8 using real host resources.
- [ ] Per-project and per-owner quotas prevent one project from monopolizing the host.
- [ ] Jobs support explicit priority and fair scheduling.
- [ ] Write-capable agents can automatically run in isolated Git worktrees.
- [ ] File/resource claims prevent conflicting agents from editing the same resource concurrently.
- [ ] A successful process exit is never sufficient completion evidence for mutating jobs.
- [ ] Verification pipelines can require artifacts, hashes, tests, build, lint, or custom checks.
- [ ] Job DAGs support dependencies, joins, cancellation propagation, and bounded fan-out.
- [ ] Agent roles/profiles configure CLI, model/provider, permissions, timeout, budget, verifier, and workspace policy.
- [ ] Reviewer and consensus modes can validate another agent's result before acceptance.
- [ ] Bridge crash/restart can reconcile jobs without blind side-effect replay.
- [ ] T-Line exposes a live multi-agent orchestration view.
- [ ] Full audit trail records dispatch, authorization, resource claims, tool policy, changes, verifier results, and commit provenance.
- [ ] Production tests prove 4 parallel AGY workers on one host and resource-aware throttling under pressure.

Non-goals for v1:

- No distributed scheduler across multiple machines.
- No automatic takeover of an unknown foreign CLI PID.
- No blind replay of unknown write/tool effects.
- No bypass of project access, YOLO, OAuth/tool scope, or workspace isolation.
- No automatic merge of conflicting worktrees.

---

# 3. Architecture target

```text
MCP / T-Line / Core
        |
        v
CLI Bridge Orchestrator
        |
        +-- Admission Controller
        |     +-- permission/capability snapshot
        |     +-- quota
        |     +-- resource budget
        |     +-- idempotency
        |
        +-- Scheduler
        |     +-- priorities
        |     +-- dynamic slots
        |     +-- project fairness
        |     +-- backpressure
        |
        +-- Resource Coordinator
        |     +-- workspace/file claims
        |     +-- Git worktrees
        |     +-- CDP/browser leases
        |
        +-- Job Runtime
        |     +-- AGY
        |     +-- Claude
        |     +-- Codex/custom adapters
        |
        +-- Verification Runtime
        |     +-- artifact hash
        |     +-- build/test/lint
        |     +-- reviewer
        |     +-- acceptance contract
        |
        +-- Durable Journal
        |     +-- job events
        |     +-- process identity
        |     +-- claims
        |     +-- checkpoints
        |     +-- audit provenance
        |
        +-- T-Line Orchestration UI
```

The existing CLI Bridge job store remains authoritative for CLI delegation metadata. The existing assistant task runtime should be integrated instead of creating another unrelated task database.

---

# 4. Phase P0 — Capacity cleanup and stale-slot recovery

**Priority:** Critical
**Goal:** restore reliable use of all configured slots before increasing concurrency.

## P0.1 Process identity evidence

- [x] Extend slot metadata with immutable process start identity, not PID alone.
- [x] Record bridge owner PID + start time/birth identity.
- [x] Record CLI child PID + start identity where available.
- [x] Record job ID, workspace digest, CLI adapter, acquiredAt, heartbeatAt.
- [x] Never expose cross-project sensitive metadata through normal MCP status output.

## P0.2 Safe stale-slot classifier

States:

- [x] `active_verified`
- [x] `owner_alive_child_alive`
- [x] `owner_dead_child_alive_review_required`
- [x] `owner_dead_child_dead_recoverable`
- [x] `identity_mismatch_blocked`
- [x] `corrupt_blocked`

Rules:

- [x] PID reuse must never classify a slot as safe.
- [x] Missing heartbeat alone is not sufficient proof of death.
- [x] Unknown/corrupt metadata fails closed.
- [x] Recovery removes a slot only after process identity proves both original owner and child are gone.

## P0.3 Operator and automatic recovery

Add:

- [x] `delegate.slots` -> summarized state/counts.
- [x] `delegate.recovery` -> read-only detailed diagnosis for owned/authorized jobs.
- [x] `delegate.recover-slot` -> explicit safe recovery of a proven orphan.
- [x] Optional automatic recovery only for `owner_dead_child_dead_recoverable`.

### P0 acceptance

- [x] Reproduce stale/orphan capacity conditions in tests and live audit.
- [x] Prove slot cannot be stolen while original process is alive.
- [x] Prove PID reuse cannot unlock it.
- [x] Prove a fully dead owner+child slot is recovered.
- [x] After recovery, all 4 current default slots can be acquired and released in the isolated acceptance run.
- [x] No existing CLI job is killed during recovery.

---

# 5. Phase P1 — Dynamic concurrency and resource-aware scheduling

**Goal:** replace fixed host capacity with bounded adaptive capacity.

## P1.1 Resource sampler

Collect bounded local evidence:

- [ ] CPU utilization and load window.
- [ ] Available/system RAM.
- [ ] SuperAgent/CLI Bridge RSS.
- [ ] Optional GPU/VRAM if discoverable without privileged dependencies.
- [ ] Disk free space for worktrees/artifacts.
- [ ] Number of active expensive build/render/browser jobs.

Do not persist high-frequency raw telemetry indefinitely.

## P1.2 Capacity policy

Introduce:

- [ ] `minSlots` default 2.
- [ ] `maxSlots` default 8.
- [ ] `configuredSlots` operator ceiling.
- [ ] `effectiveSlots` calculated from resource budget.
- [ ] Hysteresis/cooldown to prevent slot-count flapping.
- [ ] Backpressure state when host is under pressure.

Example policy:

- CPU > 90% sustained -> no new heavy job.
- low available RAM -> lower effective slots.
- active build/render -> reserve resources.
- healthy host -> gradually increase to configured ceiling.

No currently running job is terminated merely because effective capacity falls.

## P1.3 Per-job resource class

- [ ] `light`
- [ ] `normal`
- [ ] `heavy`
- [ ] `exclusive`

Profiles can map tasks/CLIs to a default class.

### P1 acceptance

- [ ] Capacity changes between 2 and 8 in deterministic tests.
- [ ] Existing jobs continue when capacity contracts.
- [ ] New jobs queue under pressure.
- [ ] Capacity expands after cooldown.
- [ ] Four AGY jobs can run concurrently on a healthy host.

---

# 6. Phase P2 — Project quotas, fairness, and priority queue

## P2.1 Priority

Add:

- [ ] `critical`
- [ ] `high`
- [ ] `normal`
- [ ] `low`

Default = `normal`.

Priority must not bypass authorization or resource claims.

## P2.2 Quotas

Support:

- [ ] host-wide maximum.
- [ ] per-project maximum.
- [ ] per-owner/session maximum.
- [ ] per-CLI adapter maximum.
- [ ] optional heavy-job maximum.

## P2.3 Fair scheduler

Use weighted/fair queueing so one project cannot starve others.

Acceptance:

- [ ] critical job moves ahead of queued low-priority jobs.
- [ ] critical job does not kill already-running jobs.
- [ ] one project cannot consume every slot when another authorized project is waiting.
- [ ] queue ordering is durable across bridge restart.

---

# 7. Phase P3 — Worktree isolation and resource claims

**Goal:** allow several coding agents to work safely at the same time.

## P3.1 Automatic worktree mode

For write-capable Git jobs:

- [ ] create `.superagent-r/worktrees/<job-id>` or approved equivalent.
- [ ] base from pinned source commit.
- [ ] record base SHA.
- [ ] give each agent its own branch/worktree.
- [ ] delete only after terminal state + retention policy.
- [ ] never use worktree mode for a repo with unresolved unsafe Git state unless explicitly approved.

## P3.2 Resource claims

Support claims such as:

- [ ] `file:<path>`
- [ ] `tree:<directory>`
- [ ] `git-branch:<name>`
- [ ] `port:<number>`
- [ ] `cdp-tab:<id>`
- [ ] `service:<name>`

Claim modes:

- [ ] read/shared.
- [ ] write/exclusive.

## P3.3 Conflict behavior

- overlapping write claims -> queue/fail.
- read + write overlap -> queue writer or policy decision.
- separate worktrees still require merge conflict verification.
- claims are leases with owner identity, not advisory labels.

### P3 acceptance

- [ ] 4 AGY jobs edit separate worktrees concurrently.
- [ ] same-file write collision is prevented before agent mutation.
- [ ] separate-file jobs proceed concurrently.
- [ ] orphan claim recovery follows process-identity proof.
- [ ] base SHA and resulting commit SHA are recorded.

---

# 8. Phase P4 — Verified completion contracts

**Goal:** replace `exit 0 = maybe succeeded` with evidence-backed completion.

## P4.1 Acceptance contract

Extend `expectedArtifacts` into:

```ts
acceptance: {
  artifacts?: [...],
  commands?: [...],
  tests?: [...],
  build?: [...],
  gitDiff?: {...},
  maxChangedFiles?: number,
  requireCommit?: boolean,
  customVerifier?: ...
}
```

## P4.2 Completion states

- [ ] `succeeded_unverified`
- [ ] `verifying`
- [ ] `verified`
- [ ] `verification_failed`
- [ ] `permission_blocked`
- [ ] `failed`
- [ ] `timed_out`
- [ ] `cancelled`
- [ ] `unknown_outcome_review_required`

## P4.3 Verification

- [ ] SHA-256 artifact evidence.
- [ ] build/test exit status.
- [ ] bounded Git diff inspection.
- [ ] protected-file policy.
- [ ] optional reviewer job.
- [ ] verification must not blindly rerun mutating agent work.

### P4 acceptance

- [ ] exit 0 with missing artifact cannot become `verified`.
- [ ] changed artifact + passing tests becomes `verified`.
- [ ] test failure becomes `verification_failed`.
- [ ] verifier crash is distinct from agent failure.

---

# 9. Phase P5 — Agent profiles and role routing

Introduce versioned profiles:

- [ ] `architect`
- [ ] `coder`
- [ ] `reviewer`
- [ ] `tester`
- [ ] `researcher`
- [ ] custom project profiles

Profile fields:

- CLI adapter.
- model/provider flags.
- permission mode.
- system instructions.
- allowed capabilities.
- resource class.
- timeout.
- token/cost budget.
- max retries.
- worktree policy.
- verifier policy.
- network policy.
- secrets/env allowlist.

No arbitrary raw CLI flags may override protected policy fields.

---

# 10. Phase P6 — DAG orchestration

Add a durable graph model:

```text
audit
  |
  v
implement ----+
  |           |
  v           v
unit-test   security-review
  |           |
  +-----+-----+
        |
        v
      judge
        |
        v
   verified commit
```

## Features

- [ ] dependency edges.
- [ ] fan-out.
- [ ] join/barrier.
- [ ] conditional edges.
- [ ] fail-fast / continue-on-error.
- [ ] bounded fan-out.
- [ ] cancellation propagation.
- [ ] graph-level timeout/budget.
- [ ] durable graph state.
- [ ] child job provenance.

Suggested MCP actions:

- [ ] `orchestrate.start`
- [ ] `orchestrate.get`
- [ ] `orchestrate.cancel`
- [ ] `orchestrate.tail`
- [ ] `orchestrate.graph`

Do not overload `delegate.start` with a large graph schema.

---

# 11. Phase P7 — Reviewer, consensus, and speculative execution

## P7.1 Reviewer mode

Flow:

1. coder produces patch.
2. verifier runs deterministic checks.
3. reviewer receives diff + evidence, not unrestricted hidden workspace context by default.
4. reviewer returns structured verdict.
5. acceptance policy decides whether job is verified.

Verdict:

- approve.
- request_changes.
- reject.
- insufficient_evidence.

## P7.2 Consensus mode

- [ ] dispatch same bounded problem to N independent agents.
- [ ] keep answers isolated.
- [ ] judge receives normalized results.
- [ ] consensus is advisory unless deterministic verifier also passes for code mutations.

## P7.3 Speculative mode

- [ ] allow 2–3 agents to attempt separate worktrees.
- [ ] first candidate satisfying acceptance contract wins.
- [ ] losers are cancelled only through verified bridge ownership.
- [ ] no auto-merge of competing candidates.

---

# 12. Phase P8 — Crash reconciliation and checkpoint/resume

## P8.1 Job checkpoint

Persist:

- last structured agent event.
- CLI conversation/session ID if provider supports it.
- process birth identity.
- worktree/branch.
- resource claims.
- accepted side-effect boundary.
- verifier state.

## P8.2 Restart behavior

After Bridge/Core reboot:

- terminal job -> read normally.
- alive verified CLI child -> observe/reattach only if provider and process identity allow it.
- dead child + no unknown write -> eligible for supervised retry.
- unknown POST/write outcome -> operator review, never blind replay.
- permission prompt pending -> surface as blocked, do not fabricate completion.

Acceptance:

- [ ] reboot during read-only job reconciles safely.
- [ ] reboot after unknown mutating request never duplicates the write.
- [ ] worktree and artifact evidence remain available.

---

# 13. Phase P9 — Security and isolation hardening

## Permission profile

Evolve beyond the current AGY modes into capability snapshots:

- [ ] read-only.
- [ ] edit-no-shell.
- [ ] safe-shell.
- [ ] git-write.
- [ ] browser.
- [ ] network-restricted.
- [ ] full-auto.

The existing `permissionMode` remains backward compatible but maps into a richer capability profile.

## Environment isolation

- [ ] do not inherit all parent env by default.
- [ ] explicit environment allowlist.
- [ ] secret references instead of raw values in job metadata.
- [ ] redact secret values from logs.
- [ ] per-job network policy: offline / localhost / allowlist / unrestricted.
- [ ] sensitive log retention controls.

---

# 14. Phase P10 — Provider-neutral adapters

Define normalized adapter interface for:

- AGY.
- Claude.
- Codex when installed.
- custom CLI.
- future Gemini/Qwen/OpenCode/Aider adapters.

Normalized events:

- init.
- planning.
- reading.
- editing.
- shell.
- tool_call.
- waiting_permission.
- testing.
- result.
- error.

Each adapter declares capabilities:

- structured stream support.
- interactive resume.
- permission mode support.
- usage/token reporting.
- image/multimodal support.
- conversation resume support.

---

# 15. Phase P11 — T-Line Multi-Agent Orchestration Dashboard

Create a first-class T-Line view.

## Host strip

Show:

- effective slots / max slots.
- CPU/RAM pressure.
- queued/running.
- stale/recovery-required slots.

## Agent cards

Each active job:

- role/profile.
- CLI/model.
- project/worktree.
- priority.
- stage.
- elapsed time.
- last progress.
- resource class.
- changed file count.
- verifier state.
- approval/permission state.

Actions:

- inspect.
- tail log.
- steer/respond.
- cancel.
- retry.
- open diff.
- open worktree.
- approve gated action.

## Graph view

For DAG orchestration:

- node states.
- dependency edges.
- blocked reasons.
- verifier results.
- final accepted candidate.

No UI action may bypass backend authorization.

---

# 16. Phase P12 — Production observability and retention

Metrics:

- queue wait.
- runtime duration.
- success/verified/failure rates.
- permission-blocked count.
- stale-slot rate.
- retry rate.
- average resource pressure.
- project concurrency.
- verifier failures.
- agent/model usage where available.

Retention:

- bounded job metadata.
- bounded log files.
- safe compaction of terminal job shards.
- never compact active/unknown jobs.
- retention dry-run before deletion.
- provenance needed by commits remains retained according to policy.

---

# 17. Phase P13 — Release certification

## Required automated suites

- [ ] slot/process identity tests.
- [ ] stale recovery tests.
- [ ] dynamic capacity tests.
- [ ] quota/fair scheduling tests.
- [ ] worktree isolation tests.
- [ ] resource claim collision tests.
- [ ] artifact/verification tests.
- [ ] DAG transition tests.
- [ ] crash/restart reconciliation tests.
- [ ] provider adapter contract tests.
- [ ] authorization/security matrix.
- [ ] T-Line UI tests.

## Required live E2E

### E2E A — Four AGY workers

- Start 4 independent AGY background jobs.
- Confirm 4 distinct jobs and process identities.
- Confirm simultaneous `running`.
- Confirm all release slots afterward.
- Confirm no cross-job log/artifact leakage.

### E2E B — Four isolated coding agents

- One repo.
- Four worktrees.
- Four non-overlapping edits.
- Parallel tests.
- Verify each candidate independently.

### E2E C — Collision

- Two jobs request same write claim.
- Exactly one gets claim.
- Other queues or fails clearly.
- No concurrent file mutation.

### E2E D — Resource pressure

- Saturate host with bounded heavy job.
- Confirm scheduler reduces admissions.
- Existing tasks remain alive.
- Capacity recovers after pressure clears.

### E2E E — Bridge crash

- Run 2 jobs.
- Kill/restart Bridge.
- Reconcile ownership.
- No duplicate writes.
- No unsafe slot theft.

### E2E F — DAG

- architect -> 2 coders -> tests -> reviewer -> accepted result.
- Confirm dependency ordering and join.
- Confirm failure propagation.

---

# 18. Implementation sequence

Recommended order:

## Milestone M1 — Reliable parallel capacity

- [x] P0 stale-slot recovery.
- [x] Restore all 4 default slots.
- [x] 4-AGY live concurrency test.

**Release gate:** CLI Bridge Parallel Runtime v1.

## Milestone M2 — Adaptive scheduler

- [ ] P1 resource-aware 2–8 slots.
- [ ] P2 quota + priority + fairness.

**Release gate:** scheduler remains deterministic under pressure.

## Milestone M3 — Safe coding concurrency

- [ ] P3 worktree isolation.
- [ ] resource claims.
- [ ] P4 completion contracts/verifiers.

**Release gate:** 4 coding agents can work safely without shared-workspace races.

## Milestone M4 — Orchestration

- [ ] P5 roles.
- [ ] P6 DAG.
- [ ] P7 reviewer/consensus/speculation.

**Release gate:** multi-agent workflow produces one evidence-backed accepted output.

## Milestone M5 — Resilience/security

- [ ] P8 checkpoint/reconciliation.
- [ ] P9 isolation/security.
- [ ] P10 normalized adapters.

**Release gate:** restart-safe, provider-neutral runtime.

## Milestone M6 — Productization

- [ ] P11 T-Line dashboard.
- [ ] P12 metrics/retention.
- [ ] P13 production certification.

**Release gate:** Multi-Agent Execution Runtime v1 production-certified.

---

# 19. Suggested code layout

Prefer extending existing modules rather than making a parallel runtime.

```text
src/core/tools/
  cliBridge.ts
  cliBridgeJobStore.ts
  cliBridgeCapacity.ts
  cliBridgeScheduler.ts              # new
  cliBridgeResourceSampler.ts        # new
  cliBridgeResourceClaims.ts         # new
  cliBridgeWorktreeManager.ts        # new
  cliBridgeAcceptance.ts             # new
  cliBridgeVerifier.ts               # new
  cliBridgeProfiles.ts               # new
  cliBridgeDag.ts                    # new
  cliBridgeReconciliation.ts         # new
  cliBridgeAdapters/
    adapter.ts
    agy.ts
    claude.ts
    codex.ts
    custom.ts

src/core/assistant/
  assistantTaskStore.ts
  assistantTaskDispatcher.ts
  assistantTaskOrchestrator.ts        # integrate CLI Bridge jobs

tests/
  cliBridgeCapacityRecovery.test.ts
  cliBridgeAdaptiveScheduler.test.ts
  cliBridgeResourceClaims.test.ts
  cliBridgeWorktreeIsolation.test.ts
  cliBridgeAcceptance.test.ts
  cliBridgeDag.test.ts
  cliBridgeReconciliation.test.ts
  cliBridgeAdapterContract.test.ts
```

T-Line should consume an authenticated orchestration API/event feed rather than read bridge files directly.

---

# 20. Data model additions

## Job

Add fields gradually with schema version migration:

- `priority`
- `profileId`
- `resourceClass`
- `queueEnteredAt`
- `slotAcquiredAt`
- `processIdentity`
- `worktree`
- `baseCommit`
- `resourceClaims`
- `acceptanceContract`
- `verificationState`
- `verifiedAt`
- `parentGraphId`
- `parentJobId`
- `budget`
- `capabilitySnapshotDigest`

Never put raw secrets in persisted job records.

## Graph

- graph ID.
- owner/project/workspace.
- revision.
- nodes.
- edges.
- state.
- budget.
- created/started/completed timestamps.
- final accepted node/result.

All mutations use revision/idempotency checks.

---

# 21. Compatibility rules

- Existing `delegate.start` callers must continue working.
- Default fixed concurrency behavior remains available until adaptive scheduling is explicitly enabled and certified.
- Existing job shards remain readable.
- Existing `permissionMode` remains supported.
- Existing `expectedArtifacts` maps into the new acceptance contract.
- Old terminal jobs are not rewritten merely to migrate schema.
- MCP response text can remain backward compatible while adding structured result payloads.
- No provider-specific AGY behavior should leak into the generic scheduler contract.

---

# 22. Safety invariants

These are non-negotiable:

1. **No PID-only cleanup.**
2. **No blind retry of unknown mutating effects.**
3. **No automatic merge of unresolved Git conflicts.**
4. **No cross-project slot/job metadata leakage.**
5. **No permission escalation through generic CLI args.**
6. **No secret persistence in job metadata/logs.**
7. **No worktree deletion while job/verification provenance is still required.**
8. **No `verified` status without explicit evidence.**
9. **No scheduler priority may bypass authorization.**
10. **No dashboard action may bypass the server-side policy layer.**

---

# 23. Immediate next execution checklist

Start here:

- [x] **M1.1** Inspect occupied slots 0 and 3 using process birth identity.
- [x] **M1.2** Implement stale-slot classifier.
- [x] **M1.3** Add safe orphan-slot recovery.
- [x] **M1.4** Add regression tests for PID reuse and live owner protection.
- [x] **M1.5** Recover only slots proven orphaned.
- [x] **M1.6** Run 4 simultaneous AGY read-only probes.
- [ ] **M1.7** Run 4 simultaneous isolated Git-worktree probes.
- [x] **M1.8** Record evidence in this document.
- [ ] **M2.1** Implement resource sampler.
- [ ] **M2.2** Implement adaptive 2–8 slot scheduler.
- [ ] **M2.3** Add project quota + priority queue.
- [ ] **M3.1** Implement worktree manager and exclusive write claims.
- [ ] **M3.2** Implement acceptance contract and verifier pipeline.
- [ ] **M4.1** Implement agent profiles.
- [ ] **M4.2** Implement DAG orchestration.
- [ ] **M4.3** Implement reviewer/consensus modes.
- [ ] **M5.1** Implement crash reconciliation/checkpoints.
- [ ] **M6.1** Build T-Line orchestration dashboard.
- [ ] **M6.2** Run full production certification.

---

# 24. Evidence log

Use this section as implementation progresses.

## 2026-10-28 baseline

- [x] MCP can call `superagent_cli_bridge`.
- [x] AGY installed and callable.
- [x] Two AGY jobs launched concurrently through MCP.
- [x] Separate capacity slots observed: slot 1 and slot 2.
- [x] Separate CLI PIDs observed.
- [x] Both AGY jobs returned expected independent results.
- [x] Default host capacity reported as four slots.
- [x] Stale/live capacity ownership audited and recovered only with process-identity evidence:
  - Before M1 delegation, a stale Slot 0 lease for job `clj_1792654617405_23ab1f9c` was inspected. Recorded owner PID 29912 and child PID 34736 were both absent when checked against their stored process-start identities. The lease was removed without signalling any process, and its stale active shard was reconciled to `interrupted` without replay.
  - Other occupied slots belonged to live AGY children and were left untouched. During the M1 implementation run, live slot inspection showed active verified jobs plus slots that naturally became available as unrelated jobs completed.
  - Independent audit subsequently added a regression ensuring a foreign stale `running` shard cannot falsely consume this runtime's in-process admission count.
- [x] Four-agent concurrency proven:
  - 4 simultaneous AGY background delegations executed concurrently via CLI Bridge (`startDelegateJob` with `--mode plan`):
    - AGY Alpha: Job `clj_1793138836610_2bbfa7b3`, capacity slot 0, PID 42932, duration 14375ms, exitCode 0.
    - AGY Beta: Job `clj_1793138836610_253329e2`, capacity slot 1, PID 5368, duration 19447ms, exitCode 0.
    - AGY Gamma: Job `clj_1793138836594_20380909`, capacity slot 2, PID 44176, duration 14299ms, exitCode 0.
    - AGY Delta: Job `clj_1793138836610_bd1596ca`, capacity slot 3, PID 43288, duration 13834ms, exitCode 0.
  - Mid-run observation verified all 4 slots in `active_verified` state simultaneously with distinct PIDs.
  - Post-run observation verified all 4 slots cleanly returned to `available` state.
  - The 4-worker probe used isolated capacity/config roots, **not four Git worktrees**. Therefore M1.7 remains open until real isolated Git-worktree coding probes are executed.
- [x] Independent post-delegation audit completed:
  - Fixed host-wide slot metadata leakage; `delegate.slots` is summary-only and detailed recovery remains workspace/job scoped.
  - Fixed false local admission saturation from foreign stale active shards; host-wide capacity remains authoritative through atomic slots.
  - Legacy/incomplete leases without child evidence now fail closed unless terminal job evidence exists.
  - Orphan recovery now uses an exclusive recovery marker, token/job recheck, and atomic quarantine rename to prevent replacement-owner races.
  - Capacity metadata enrichment updates are serialized per lease.
  - External MCP schema now exposes `delegate.recover-slot` and bounded `slot`.
  - Final independent regression: **114 passed, 0 failed, 502 assertions**; `bun run build` passed.
  - Fresh post-fix real-AGY probe: four jobs simultaneously observed in `active_verified`, all exit 0, all four slots returned to `available`.
- [ ] Four isolated Git-worktree coding probes proven.
- [ ] Adaptive 2–8 scheduling implemented.
- [ ] Worktree isolation automated.
- [ ] DAG orchestration implemented.
- [ ] Production multi-agent certification complete.

---

# 25. Final target

The final product should allow an authorized caller to express:

> Audit this subsystem with an architect, let two coders independently implement the highest-risk fixes in isolated worktrees, have a tester verify both, let a reviewer choose the evidence-backed candidate, and return the accepted commit — while SuperAgent automatically manages slots, resources, permissions, conflicts, crash recovery, and audit provenance.

At that point CLI Bridge is no longer merely a CLI launcher. It becomes SuperAgent's **local multi-agent execution runtime**.
