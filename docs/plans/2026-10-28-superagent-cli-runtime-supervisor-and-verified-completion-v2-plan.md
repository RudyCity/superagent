# SuperAgent CLI Runtime Supervisor & Verified Completion V2 — Implementation Plan

**Date:** 2026-10-28  
**Status:** Planned / not yet implemented  
**Primary runtime:** SuperAgent CLI on Windows  
**Priority:** P0 reliability follow-up after Windows subprocess-console hardening  
**Depends on:**  
- `docs/plans/2026-10-28-windows-background-subprocess-console-splash-elimination-plan.md`
- `docs/plans/2026-10-28-agy-cli-bridge-verified-completion-hardening-plan.md`
- `docs/plans/2026-10-26-runtime-ownership-and-safe-recovery-master-plan.md`

## 1. Objective

Build the next reliability layer on top of the completed Windows subprocess policy and CLI Bridge completion fixes.

The target is not merely “no console splash.” SuperAgent CLI should become capable of:

1. knowing which OS processes it owns;
2. distinguishing live, detached, persistent, orphaned, unknown, and externally owned processes;
3. safely cleaning only process trees it can prove it owns;
4. recovering conservatively after CLI/runtime crashes;
5. verifying delegated work using durable acceptance evidence rather than agent self-report;
6. scheduling work based on real CPU/RAM/process pressure;
7. exposing actionable process/runtime diagnostics from the CLI;
8. certifying long-running operation with repeatable soak tests.

This plan is CLI-first. T-Line/Tauri is not an acceptance dependency for this work.

---

## 2. Current baseline

Already implemented before this plan:

- centralized Windows process intent policy:
  - `headless`
  - `capturedInteractive`
  - `visibleTerminal`;
- `windowsHide: true` enforcement for internal/background Windows subprocesses;
- direct native `agy.exe` resolution where appropriate;
- hidden taskkill/process-tree cleanup helpers;
- safe/redacted process tracing;
- Windows subprocess regression and soak coverage;
- CLI Bridge distinction between process success and verified completion;
- AGY permission-denial parsing;
- transient AGY permission denial recovery when superseded by a clean terminal result;
- terminal `denied_actions` remains a hard permission-blocked outcome.

Recent verification after those changes:

- Windows/CLI subprocess + CLI Bridge focused suite: **41 tests passed, 0 failed, 304 assertions**.
- CLI Bridge permission/completion focused suite: **43 tests passed, 0 failed, 204 assertions**.
- A live post-test inspection still found historical `agy-node.cmd` / `cmd.exe` processes whose parent process was already dead. They pre-dated the latest soak and therefore were not proven to be leaks from the new implementation, but they expose the next missing capability: ownership-aware orphan reconciliation.

Known unrelated repository health issue at plan creation:

- full TypeScript build is currently blocked by existing `src/core/mcp/mcpLogSanitizer.ts` typing errors around `chatLine`.
- This plan must not hide that failure. Build-green restoration is an entry gate before release certification.

---

## 3. Non-goals and safety boundaries

This plan must NOT:

- kill a process only because its PID appears in a stale file;
- kill every `cmd.exe`, PowerShell, `conhost.exe`, Antigravity, AGY, Bun, Node, or tunnel process on the machine;
- adopt an arbitrary process merely because its command line looks like SuperAgent;
- treat “parent PID is dead” as sufficient ownership proof;
- replay ambiguous mutating jobs after restart;
- silently enable AGY full-auto or broaden permissions;
- infer arbitrary verifier shell commands from model-authored text;
- treat exit code 0 as verified task completion;
- pool or manage Antigravity/AGY-owned sidecars unless SuperAgent has an explicit supported lifecycle contract for them;
- make T-Line/Tauri a required validation surface for this CLI-only roadmap.

---

## 4. Core invariants

### R-I1 — PID is never identity

Process identity must include enough evidence to reject PID reuse. Minimum Windows identity:

- PID;
- process creation time / start identity;
- executable path or executable fingerprint where obtainable;
- owner generation/token;
- workspace/job/session owner;
- recorded parent/child relationship.

A PID mismatch or unavailable identity means **unknown**, not safe-to-kill.

### R-I2 — Process ownership is explicit

Every SuperAgent-owned child should be registered at launch whenever technically possible. Discovery after the fact is diagnostic evidence, not equivalent to ownership.

### R-I3 — Unknown processes fail closed

If SuperAgent cannot prove ownership, it may report the process but must not terminate, adopt, or mutate it automatically.

### R-I4 — Orphan cleanup is bounded

Automatic cleanup is allowed only when:

1. ownership is proven;
2. the owning SuperAgent job/session/generation is terminal or dead;
3. process identity still matches the registered identity;
4. the process is not marked persistent/external;
5. there is no active lease renewal;
6. cleanup policy permits termination.

### R-I5 — Process success and task proof stay separate

Keep the current model:

- process state;
- verification state;
- warnings/evidence.

Do not collapse them into one overloaded status.

### R-I6 — Warnings do not erase verified evidence

A recovered transient permission denial may become a warning after a later clean final AGY result. A terminal AGY `denied_actions` declaration remains blocking.

### R-I7 — No automatic replay of unknown mutations

After crash/restart, a job with unknown external side effects must become `unknown_outcome_review_required`, not automatically rerun.

### R-I8 — Resource control is advisory before destructive

Scheduler pressure may delay or throttle new jobs. It must not terminate healthy work merely to reduce RAM/CPU unless the task already violates an explicit configured hard limit and cleanup semantics are safe.

### R-I9 — Verification commands are policy-bound

Verified Completion V2 may run only typed/allowlisted verifier operations already permitted by the workspace/tool policy. No model-produced arbitrary shell string becomes trusted verification simply because it appears in a plan.

### R-I10 — Every automatic decision is explainable

Reaper, recovery, scheduler, and verifier decisions must produce bounded evidence explaining why a process/job was cleaned, retained, blocked, throttled, verified, or escalated for review.

---

## 5. Target architecture

```text
                    SuperAgent CLI
                         |
                Runtime Process Supervisor
                         |
        +----------------+----------------+
        |                |                |
 Process Registry   Resource Monitor   Recovery Engine
        |                |                |
        +-------+--------+-------+--------+
                |                |
          Spawn Policy      Orphan Reaper
                |
      CLI Bridge / MCP / Git / Hooks /
      Tunnels / Background Commands
                |
      registered process descendants

CLI Bridge job
    |
    +-- process state
    +-- acceptance contract
    +-- verification evidence
    +-- warning events
    +-- process ownership references
    |
    '-- user-facing outcome
        VERIFIED
        VERIFIED_WITH_WARNINGS
        PROCESS_OK / UNVERIFIED
        VERIFICATION_FAILED
        PERMISSION_BLOCKED
        REVIEW_REQUIRED
```

The existing `processSpawnPolicy.ts` remains the policy entrypoint. The new supervisor should build on it rather than replacing it with another unrelated spawning abstraction.

---

# 6. Workstreams

## P0 / M0 — Restore a trustworthy green baseline

### Goal

Prevent this roadmap from being “verified” on top of an already failing main build.

### Tasks

- [ ] Resolve or isolate the current `mcpLogSanitizer.ts` `chatLine` TypeScript error.
- [ ] Run the relevant existing CLI Bridge and subprocess suites.
- [ ] Run `bun run build`.
- [ ] Run `git diff --check`.
- [ ] Record the exact baseline commit and pre-existing unrelated dirty files.
- [ ] Never stage unrelated concurrent work.

### Acceptance

- [ ] `bun run build` passes.
- [ ] Windows subprocess regression remains green.
- [ ] CLI Bridge verified-completion regression remains green.
- [ ] No unrelated working-tree changes are included in the implementation commit.

---

## P0 / M1 — Durable Process Ownership Registry

### Goal

Create one canonical registry for processes that SuperAgent actually launches and owns.

### Proposed module

- `src/core/process/processSupervisor.ts`
- `src/core/process/processRegistry.ts`
- optional persisted store under SuperAgent config/runtime state.

### Proposed record

```ts
type ManagedProcessRecord = {
  processId: string;             // SuperAgent stable record id
  pid: number;
  creationIdentity: string;      // Windows creation-time/start fingerprint
  executable: string;
  sanitizedArgvDigest?: string;
  parentPid?: number;
  parentCreationIdentity?: string;

  owner: {
    runtimeGeneration: string;
    workspaceDigest?: string;
    jobId?: string;
    sessionId?: string;
    component: string;
  };

  intent: "headless" | "capturedInteractive" | "visibleTerminal";
  lifecycle: "ephemeral" | "job" | "session" | "persistent" | "external";
  cleanupPolicy: "terminate_with_owner" | "lease_managed" | "manual_only";

  startedAt: number;
  heartbeatAt?: number;
  endedAt?: number;
  observedExitCode?: number | null;

  state:
    | "starting"
    | "running"
    | "detached"
    | "terminal"
    | "orphan_candidate"
    | "unknown"
    | "externally_owned";
};
```

### Tasks

- [ ] Register managed subprocesses through the central process-launch policy.
- [ ] Assign stable owner/process IDs independent of OS PID.
- [ ] Capture Windows process creation identity immediately after spawn.
- [ ] Persist bounded registry records atomically.
- [ ] Persist no raw prompts or secrets.
- [ ] Track explicit lifecycle and cleanup policy.
- [ ] Mark externally owned processes distinctly from SuperAgent-owned processes.
- [ ] Add registry retention and compaction.
- [ ] Add schema versioning and backward-compatible reads.
- [ ] Add tests for PID reuse and stale records.

### Acceptance

- [ ] A newly launched AGY delegate can be traced from job ID to owned process record.
- [ ] `run_command`, background shell, MCP helper, and tunnel launches can be attributed to an owner.
- [ ] A fabricated/stale record cannot authorize process termination.
- [ ] Registry survives SuperAgent restart without automatically adopting unknown processes.

---

## P0 / M2 — Ownership-Aware Orphan Process Reaper

### Goal

Safely clean SuperAgent-owned leftovers without broad process killing.

### Two-stage model

#### Stage A — detect/quarantine

A process becomes `orphan_candidate` only when:

- registry says SuperAgent owns it;
- owner job/session/runtime generation is terminal/dead;
- live OS process identity still exactly matches;
- lease/heartbeat is stale beyond a configured grace period;
- lifecycle is not `persistent` or `external`.

#### Stage B — reap

Before termination, re-check all identity and ownership evidence. If any evidence changed, abort and mark for review.

### Tasks

- [ ] Implement read-only orphan scan.
- [ ] Implement `orphan_candidate` evidence record.
- [ ] Add configurable grace period.
- [ ] Add second identity verification immediately before kill.
- [ ] Terminate the proven process tree using existing hidden cleanup helpers.
- [ ] Record cleanup result and descendants actually observed.
- [ ] Never kill an unregistered historical AGY/Antigravity process automatically.
- [ ] Provide a manual operator path for unknown historical orphan candidates.
- [ ] Add dry-run mode as default for diagnostics.
- [ ] Add fault-injection tests:
  - PID reused;
  - process disappeared;
  - owner revived;
  - lease renewed during scan;
  - child changed parent;
  - identity unavailable;
  - access denied.

### Suggested CLI

```text
/status processes
/doctor processes
/processes orphan scan
/processes orphan reap --owned-only
```

Any destructive command must use the existing permission model.

### Acceptance

- [ ] A known SuperAgent-owned orphan can be reaped.
- [ ] A PID-reused process is never killed.
- [ ] Historical `agy-node.cmd` processes not proven owned are only reported.
- [ ] Reaper leaves live jobs and persistent services untouched.
- [ ] No visible terminal splash during reaping.

---

## P0 / M3 — Crash-Safe Process Reconciliation

### Goal

Recover process ownership state conservatively after SuperAgent CLI crash/restart.

### Tasks

- [ ] At startup, compare persisted registry against live OS processes.
- [ ] Classify each record:
  - terminal;
  - still-owned/live;
  - orphan candidate;
  - identity mismatch;
  - unknown;
  - persistent external.
- [ ] Reconcile CLI Bridge job state with process registry state.
- [ ] Preserve `unknown_outcome_review_required` for ambiguous mutating jobs.
- [ ] Do not automatically reattach stdin/stdout to arbitrary surviving children.
- [ ] Do not replay delegated prompts.
- [ ] Allow safe observation of surviving processes.
- [ ] Add restart fixture tests and simulated process identity reuse.

### Acceptance

- [ ] Restart cannot turn an unknown job into verified.
- [ ] Restart cannot kill an identity-mismatched PID.
- [ ] A proven owned orphan becomes a reaper candidate.
- [ ] A valid persistent process can survive CLI restart without being misclassified as leak.

---

## P0 / M4 — Verified Completion V2

### Goal

Make completion proof automatic where safe, explicit where necessary, and durable.

### Important correction to previous invariant

The older wording “any trustworthy permission denial always wins” is too coarse for streamed AGY execution. The new invariant is:

- an intermediate denied tool event is a recorded warning/failure signal;
- if AGY later emits a clean terminal result, that intermediate denial may be marked recovered;
- a terminal result with non-empty `denied_actions` remains blocking;
- verification evidence still determines whether the task becomes verified.

### Contract modes

```ts
type AcceptanceMode =
  | "none"
  | "safe-default"
  | "explicit";
```

#### `none`

Existing behavior. Exit 0 => `PROCESS_OK / UNVERIFIED`.

#### `safe-default`

SuperAgent may derive only safe deterministic checks from trusted repository metadata:

- explicitly declared expected artifacts;
- known package-script test/build names;
- `git diff --check`;
- bounded changed-file checks;
- existing typed verifier registry.

It must not execute arbitrary shell text extracted from an LLM response or free-form Markdown plan.

#### `explicit`

Caller supplies the full bounded `AcceptanceContract`.

### Tasks

- [ ] Add contract version.
- [ ] Add `acceptanceMode`.
- [ ] Add a safe acceptance-profile builder.
- [ ] If `planPath` exists, parse only structured metadata/checklist/artifact references; never trust arbitrary commands embedded in prose.
- [ ] Add verifier evidence hashes, timestamps, exit codes, bounded output digest, and source.
- [ ] Persist verification evidence durably.
- [ ] Expose missing-proof reasons.
- [ ] Keep legacy `expectedArtifacts` compatibility.
- [ ] Add result normalization for all providers, not only AGY.
- [ ] Add regression for:
  - transient permission denial -> clean final -> verifier pass;
  - transient denial -> clean final -> verifier fail;
  - terminal `denied_actions`;
  - exit 0 with no proof;
  - artifact changed but semantic tests fail;
  - crash during verifier.

### User-facing outcome

Do not add `completed_with_warnings` as a new OS/process state.

Instead derive an outcome:

```ts
type TaskOutcome =
  | "VERIFIED"
  | "VERIFIED_WITH_WARNINGS"
  | "PROCESS_OK_UNVERIFIED"
  | "VERIFICATION_FAILED"
  | "PERMISSION_BLOCKED"
  | "REVIEW_REQUIRED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED";
```

`VERIFIED_WITH_WARNINGS` is allowed only when verification passed but non-blocking warnings remain, such as a recovered transient permission denial.

### Acceptance

- [ ] Agent self-report cannot produce `VERIFIED`.
- [ ] Terminal `denied_actions` cannot be overwritten by a later non-terminal line.
- [ ] Recovered transient denial is visible as warning.
- [ ] Verification survives process restart.
- [ ] No arbitrary verifier shell escalation is introduced.

---

## P1 / M5 — Central Runtime Resource Monitor

### Goal

Provide one source of truth for scheduler-relevant host pressure.

### Metrics

At minimum:

- total/free/available RAM;
- SuperAgent process-tree RSS;
- per-managed-process RSS where available;
- CPU utilization;
- active managed process count;
- running delegate count;
- process spawn rate;
- queue depth;
- recent OOM/kill/timeout events;
- orphan-candidate count.

### Tasks

- [ ] Add bounded polling with low overhead.
- [ ] Avoid shelling out at high frequency.
- [ ] Use existing process-pool/native APIs where appropriate.
- [ ] Track rolling windows instead of unbounded history.
- [ ] Expose read-only metrics to scheduler and status commands.
- [ ] Add stale-metric detection.

### Acceptance

- [ ] Monitoring overhead remains bounded during idle and heavy workloads.
- [ ] Scheduler never acts on silently stale pressure data.
- [ ] Metrics contain no raw prompts or secrets.

---

## P1 / M6 — Resource-Aware Scheduler V2

### Goal

Make CLI Bridge concurrency adapt to real host capacity rather than a fixed slot count alone.

### Suggested pressure levels

- `normal`
- `elevated`
- `high`
- `critical`

### Behavior

#### normal

Use configured concurrency.

#### elevated

Stop scaling upward; prefer lightweight jobs.

#### high

Reduce new heavy-job admission; queue instead of spawning.

#### critical

Pause new heavy jobs. Do not automatically kill healthy running work solely because pressure is high.

### Resource class refinement

```ts
type ResourceClass =
  | "tiny"
  | "normal"
  | "heavy"
  | "memory_heavy"
  | "cpu_heavy"
  | "browser_heavy";
```

### Tasks

- [ ] Feed process supervisor metrics into scheduler.
- [ ] Add hysteresis to prevent slot flapping.
- [ ] Add minimum/maximum concurrency.
- [ ] Add per-provider weights.
- [ ] Add per-workspace fairness.
- [ ] Account for persistent sidecars separately from active delegate slots.
- [ ] Expose admission decision reason.
- [ ] Add deterministic scheduler simulation tests.

### Acceptance

- [ ] Heavy new jobs queue under memory pressure.
- [ ] Existing healthy jobs are not killed merely to satisfy scheduler preference.
- [ ] Concurrency recovers after pressure clears.
- [ ] No starvation of small jobs behind a heavy queue.

---

## P1 / M7 — Sidecar Lifecycle Optimization

### Goal

Reduce unnecessary process churn without taking ownership of external components unsafely.

### Rule

Do **not** implement generic AGY/Antigravity sidecar pooling by forcibly adopting `agy-node.cmd` children.

First classify sidecars:

1. SuperAgent-owned and lifecycle-supported;
2. provider-managed but observable;
3. unknown/external.

Only class 1 can be pooled or explicitly reused by SuperAgent.

### Tasks

- [ ] Inventory which sidecars have a documented supported lifecycle.
- [ ] Measure spawn frequency, lifetime, RAM, and restart behavior.
- [ ] Add optional reuse only for SuperAgent-owned safe sidecars.
- [ ] For AGY/Antigravity provider-managed sidecars, prefer native AGY lifecycle controls if available.
- [ ] Add idle TTL and max-age for any SuperAgent-owned pool.
- [ ] Ensure pooled processes carry leases and ownership identity.
- [ ] Compare memory/process count before/after.

### Acceptance

- [ ] No external sidecar is killed or adopted merely for optimization.
- [ ] Pooling produces measurable reduction in churn before being enabled by default.
- [ ] A stale pooled process cannot be reused after identity mismatch.

---

## P1 / M8 — CLI Process Observability

### Goal

Make runtime ownership understandable without external Process Explorer/PowerShell debugging.

### Proposed outputs

`/status processes`

- managed process count;
- live/terminal/orphan-candidate counts;
- total managed RSS;
- oldest active process;
- job/session ownership summary;
- no secret command lines.

`/doctor processes`

- stale registry records;
- dead owners;
- orphan candidates;
- PID identity mismatches;
- persistent processes;
- unknown AGY/Antigravity descendants;
- recommended safe action.

`/status scheduler`

- configured slots;
- effective slots;
- pressure state;
- queued jobs;
- admission reasons;
- resource metrics age.

### Tasks

- [ ] Add text output first.
- [ ] Add structured MCP/API form with workspace privacy filtering.
- [ ] Redact paths/argv where caller lacks scope.
- [ ] Add bounded process-tree view.
- [ ] Distinguish “observed unknown process” from “owned process”.

### Acceptance

- [ ] Operator can identify why a job is queued.
- [ ] Operator can see orphan candidates without granting kill authority.
- [ ] Foreign workspace process metadata does not leak.

---

## P2 / M9 — Permission Intelligence

### Goal

Make recurring AGY permission friction diagnosable without automatically increasing permissions.

### Tasks

- [ ] Record normalized denial category, tool name, workspace scope, and whether recovered.
- [ ] Never persist raw secret-bearing arguments.
- [ ] Aggregate recurring denial patterns.
- [ ] Suggest the narrowest likely `permissions.allow` rule.
- [ ] Require explicit operator approval before any policy change.
- [ ] Never recommend full-auto as the default fix.
- [ ] Distinguish:
  - transient denied action with successful alternate path;
  - blocking required permission;
  - denied optional diagnostic command;
  - terminal denied action.

### Acceptance

- [ ] Suggestions are read-only.
- [ ] No permission is changed automatically.
- [ ] Historical denial metrics cannot expose another workspace's details.

---

## P2 / M10 — Production Soak & Fault-Injection Certification

### Goal

Prove that the runtime remains healthy over sustained CLI use.

### Test matrix

Run repeated cycles of:

- AGY delegate start/finish;
- AGY transient permission recovery;
- terminal permission block;
- persistent session create/send/close;
- shell run/background/cancel;
- MCP helper execution;
- Git/worktree creation and cleanup;
- tunnel doctor/status/start-stop where safe;
- process inspection;
- verifier pass/fail;
- forced timeout;
- forced cancellation;
- simulated SuperAgent owner crash;
- restart reconciliation;
- orphan candidate scan/reap using test-owned children;
- scheduler pressure transitions.

### Fault injection

- PID reuse simulation;
- registry corruption/truncated record;
- dead parent with live child;
- heartbeat loss;
- process exits during identity verification;
- verifier crash;
- out-of-memory pressure simulation where safe;
- stale capacity slot;
- stale worktree lock;
- permission denial followed by clean final result;
- terminal `denied_actions`.

### Certification targets

- zero unintended visible terminal splash;
- zero incorrectly killed foreign processes;
- zero leaked SuperAgent-owned test children;
- zero leaked capacity slots;
- zero stale locks attributable to test runs;
- no automatic replay of ambiguous mutations;
- no false `VERIFIED`;
- no terminal permission block incorrectly converted to success;
- bounded registry and log growth;
- scheduler returns to normal after pressure clears;
- build and targeted test suites green.

---

# 7. Proposed implementation order

Implement sequentially unless an isolated worktree proves a subtask independent:

1. **M0** — restore build-green baseline;
2. **M1** — durable process ownership registry;
3. **M2** — read-only orphan scanner, then safe reaper;
4. **M3** — restart reconciliation;
5. **M4** — Verified Completion V2;
6. **M5** — resource monitor;
7. **M6** — resource-aware scheduler V2;
8. **M8** — CLI observability;
9. **M7** — sidecar optimization only after ownership evidence exists;
10. **M9** — permission intelligence;
11. **M10** — soak/fault-injection certification.

Do not implement sidecar pooling before M1–M3. Without ownership, pooling increases the chance of stale process reuse and unsafe cleanup.

---

# 8. Suggested file map

Likely new modules:

- `src/core/process/processSupervisor.ts`
- `src/core/process/processRegistry.ts`
- `src/core/process/processReaper.ts`
- `src/core/process/processReconciliation.ts`
- `src/core/process/resourceMonitor.ts`

Likely modifications:

- `src/core/process/processSpawnPolicy.ts`
- `src/core/tools/cliBridgeDelegateJobs.ts`
- `src/core/tools/cliBridgeSession.ts`
- `src/core/tools/cliBridgeAcceptance.ts`
- `src/core/tools/cliBridgeTool.ts`
- scheduler/resource-claim modules already used by CLI Bridge;
- CLI command/status registration modules.

Likely tests:

- `tests/processRegistry.test.ts`
- `tests/processReaper.test.ts`
- `tests/processReconciliation.test.ts`
- `tests/resourceMonitor.test.ts`
- `tests/cliBridgeSchedulerV2.test.ts`
- `tests/cliBridgeVerifiedCompletionV2.test.ts`
- `tests/processSupervisorSoak.test.ts`

Reuse existing Windows subprocess tests rather than duplicating them.

---

# 9. Data retention and privacy

Process/runtime telemetry must be intentionally bounded.

Persist:

- stable record IDs;
- PID + creation identity;
- component/owner IDs;
- sanitized executable identity;
- timestamps;
- state transitions;
- bounded resource metrics;
- verification evidence digests;
- denial categories.

Do not persist by default:

- full prompts;
- raw API keys/tokens;
- raw OAuth values;
- unrestricted environment dumps;
- full arbitrary shell command bodies;
- full foreign-process command lines.

Apply retention/compaction separately to:

- terminal process records;
- verification evidence;
- scheduler metrics;
- permission-denial aggregates.

---

# 10. Migration strategy

### Phase A — observe only

Deploy registry + supervisor in observational mode. No automatic reaping.

### Phase B — owned test-process reaping

Enable reaping only for explicit test-owned children created by the new supervisor.

### Phase C — normal SuperAgent-owned ephemeral processes

Enable automatic cleanup for proven owned ephemeral/job children.

### Phase D — crash reconciliation

Enable restart-time orphan candidate classification. Keep ambiguous processes review-only.

### Phase E — scheduler adaptation

Enable adaptive admission after metrics and simulations are stable.

Sidecar pooling remains opt-in until independent evidence proves it beneficial and ownership-safe.

---

# 11. Rollback strategy

Every milestone must be independently disableable.

Suggested feature gates:

- `SUPERAGENT_PROCESS_SUPERVISOR=1`
- `SUPERAGENT_PROCESS_REAPER=observe|owned|off`
- `SUPERAGENT_RESOURCE_SCHEDULER_V2=1`
- `SUPERAGENT_ACCEPTANCE_V2=1`

Final names should follow existing project configuration conventions.

Rollback requirements:

- disabling supervisor must not delete registry evidence;
- disabling reaper stops destructive cleanup immediately;
- scheduler V2 can return to configured fixed concurrency;
- acceptance V2 can fall back to existing explicit `unverified` semantics;
- no rollback path may reinterpret historical unverified jobs as verified.

---

# 12. Definition of done

This roadmap is complete only when:

- [ ] full SuperAgent build is green;
- [ ] every newly managed process has durable ownership identity;
- [ ] PID reuse cannot authorize cleanup;
- [ ] orphan scan is read-only by default;
- [ ] automatic reaping touches only proven SuperAgent-owned processes;
- [ ] historical/unknown AGY sidecars are never automatically killed;
- [ ] restart reconciliation is fail-closed;
- [ ] ambiguous mutating jobs remain review-required;
- [ ] Verified Completion V2 never trusts agent self-report alone;
- [ ] recovered permission denial can produce `VERIFIED_WITH_WARNINGS` only after verifier success;
- [ ] terminal `denied_actions` remains `PERMISSION_BLOCKED`;
- [ ] scheduler responds to CPU/RAM pressure with hysteresis and fair queueing;
- [ ] scheduler never kills healthy work merely to free capacity;
- [ ] CLI exposes process/scheduler diagnostic state;
- [ ] permission intelligence never changes permissions automatically;
- [ ] sustained Windows CLI soak produces no new console splash;
- [ ] sustained soak produces no SuperAgent-owned orphan children, leaked slots, or stale locks;
- [ ] all safety/fault-injection tests pass;
- [ ] implementation and operator documentation are updated;
- [ ] final commit contains no unrelated concurrent workspace changes.

---

# 13. Recommended first implementation slice

The first coding slice should be deliberately small:

1. fix the unrelated build blocker so baseline is green;
2. implement `ManagedProcessRecord` + process registry in **observe-only mode**;
3. connect only CLI Bridge delegate launches and `run_command` to the registry;
4. add `/doctor processes` read-only output;
5. add PID-reuse and dead-parent fixtures;
6. do **not** kill anything yet.

Only after that slice passes should the reaper gain an `owned-only` destructive mode.

This sequencing gives SuperAgent visibility before authority, which is the safest way to solve the historical orphan-process problem.
