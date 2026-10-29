# SuperAgent Runtime Supervisor — Post-Batch 1 Remaining Gaps Audit

**Date:** 2026-10-28  
**Repository:** SuperAgent  
**Branch:** `main`  
**Audited HEAD:** `fcd8a358`  
**Status:** Batch 1 merged; runtime supervisor roadmap remains partially complete  
**Primary roadmap:** `docs/plans/2026-10-28-superagent-cli-runtime-supervisor-and-verified-completion-v2-plan.md`

---

## 1. Executive Summary

Batch 1 successfully delivered the **Durable Process Ownership Registry foundation** and merged it into `main`.

The implementation now provides:

- stable SuperAgent process record IDs independent from OS PID;
- process creation/start identity tracking;
- fail-closed ownership verification;
- durable versioned process registry persistence;
- bounded retention/compaction;
- prompt/secret-safe persistence;
- process lifecycle tracking for CLI Bridge delegates and shell tools;
- privacy-safe process diagnostics;
- serialized registry writes to prevent concurrent-save races;
- live creation-identity verification in diagnostics.

The implementation was verified before merge with:

- **73 tests passed**
- **0 failed**
- **454 assertions**
- `bun run build` passed
- `git diff --check` passed

After merging into `main` and restoring pre-existing parallel local work:

- **50 targeted tests passed**
- **0 failed**
- **377 assertions**
- `bun run build` passed
- no merge conflict occurred.

However, this is still only the **foundation layer**. SuperAgent does not yet have a complete ownership-aware orphan reaper, process-level crash reconciliation, process observability CLI, or full production certification.

---

# 2. Current Certification Status

| Area | Status | Notes |
|---|---|---|
| Windows subprocess console splash elimination | **CERTIFIED** | Existing regression/soak remains green |
| CLI Bridge permission recovery | **CERTIFIED** | Transient denial recovery + terminal denial blocking verified |
| CLI Bridge verified-completion baseline | **CERTIFIED / existing** | Existing verifier hardening remains green |
| Durable Process Ownership Registry | **IMPLEMENTED / PARTIALLY CERTIFIED** | Core foundation merged at `fcd8a358` |
| Global process coverage | **PARTIAL** | Only selected spawn paths registered |
| Ownership-aware orphan detection | **NOT IMPLEMENTED** | M2 |
| Ownership-aware automatic reaping | **NOT IMPLEMENTED** | M2 |
| Process registry restart reconciliation | **NOT IMPLEMENTED** | M3 |
| Process-aware resource monitoring | **PARTIAL** | Existing host sampler exists, not integrated with supervisor |
| Resource-aware scheduler V2 | **PARTIAL / ADVANCED BASELINE** | Existing scheduler already has pressure/fairness/hysteresis |
| Sidecar lifecycle optimization | **NOT IMPLEMENTED** | M7 |
| CLI process observability | **PARTIAL** | Diagnostic API exists; user-facing commands do not |
| Permission intelligence | **PARTIAL** | Detection exists; aggregation/recommendation does not |
| Production soak certification | **PARTIAL** | Strong component tests exist; integrated soak is missing |

**Overall runtime-supervisor production status: NOT YET CERTIFIED.**

---

# 3. Completed Work — Batch 1 / M1

## 3.1 New process ownership modules

Implemented:

- `src/core/process/processRegistry.ts`
- `src/core/process/processSupervisor.ts`
- `src/core/process/index.ts`

The registry implements:

- stable `recordId` independent of PID;
- runtime generation identity;
- PID + process creation identity;
- owner metadata;
- component/source metadata;
- sanitized executable and arguments;
- process state;
- cleanup policy;
- timestamps;
- exit observations;
- heartbeat state.

## 3.2 PID reuse safety

Ownership is rejected when:

- PID exists but creation identity is unavailable;
- creation identity does not match;
- process came from a historical runtime generation;
- registry is corrupt;
- record is already terminal.

**PID alone is not treated as ownership proof.**

This is the key prerequisite before any future destructive process cleanup.

## 3.3 Durable persistence

Registry persistence includes:

- schema versioning;
- atomic temp-file replacement;
- serialized save queue;
- fail-closed corrupt-registry behavior;
- bounded record retention;
- active-process preservation during compaction.

The serialized save queue was added after audit to prevent concurrent writes from racing each other.

## 3.4 Privacy and secret handling

Persistence uses existing subprocess redaction helpers.

Raw values such as:

- prompts;
- API keys;
- bearer tokens;
- encoded PowerShell payloads;
- secret-bearing arguments

must not be stored in the registry.

## 3.5 Current integrations

The Process Supervisor is currently wired into:

### CLI Bridge delegate jobs

Tracked:

- registration before launch;
- PID binding after spawn;
- creation identity;
- heartbeat;
- terminal exit observation.

### Shell tools

Tracked:

- `bash`;
- `run_command`;
- `run_background_process`.

## 3.6 Diagnostic API

`ProcessSupervisor.getProcessDiagnostics()` already provides a read-only foundation for future process status/doctor commands.

The post-AGY audit fixed diagnostics so active ownership validation reads the **live process creation identity**, rather than checking PID alone.

---

# 4. Remaining Gap — M1 Coverage Completion

M1 is implemented but not yet complete across all SuperAgent subprocess families.

## 4.1 Missing or unverified integrations

The Process Supervisor still needs systematic coverage for subprocesses launched by:

- MCP helpers;
- OpenAI/Cloudflare/Muse tunnel processes;
- CLI Bridge persistent sessions;
- Git/worktree helper subprocesses where ownership matters;
- hooks/dynamic hooks;
- process inspection helpers where child processes are launched;
- background services;
- provider helper processes that are actually owned by SuperAgent.

The goal is not to register every OS process observed by SuperAgent.

Only processes that SuperAgent explicitly launches and owns should be registered.

## 4.2 Record model still needs lifecycle refinement

Current process states are intentionally conservative:

- `registered`
- `running`
- `exited`
- `failed`
- `terminated`

For later milestones, the model still needs explicit lifecycle distinctions such as:

- ephemeral;
- job-scoped;
- session-scoped;
- persistent;
- external/provider-managed;
- orphan candidate;
- unknown.

Cleanup policy also needs clearer semantics for future reaping.

## 4.3 Backward-compatible registry evolution

Current schema is versioned, but future schema migration behavior has not yet been fully implemented.

Before M2/M3 production use, add:

- schema migration strategy;
- backward-compatible reads;
- explicit unsupported-version handling;
- recovery behavior for partially written historical state.

---

# 5. Remaining Gap — M2 Ownership-Aware Orphan Process Reaper

**Status: NOT IMPLEMENTED**

This is the highest-priority missing component.

## 5.1 Required orphan detection

A process must become an orphan candidate only when all required evidence agrees:

1. the registry proves SuperAgent originally owned it;
2. the recorded PID still exists;
3. current process creation identity matches the recorded identity;
4. owner runtime/job/session is no longer live;
5. lease/heartbeat has expired beyond a grace period;
6. lifecycle permits cleanup;
7. process is not marked persistent or external.

A dead parent PID alone must never authorize cleanup.

## 5.2 Required two-phase safety

### Phase A — scan / quarantine

Read-only classification:

- healthy owned process;
- terminal;
- historical;
- identity mismatch;
- unknown;
- external;
- orphan candidate.

### Phase B — reap

Immediately before termination:

- re-read PID;
- re-read creation identity;
- re-check owner state;
- re-check lease;
- re-check cleanup policy.

Any changed evidence must abort the reap.

## 5.3 Required operator commands

Target commands:

- `/status processes`
- `/doctor processes`
- `/processes orphan scan`
- `/processes orphan reap --owned-only`

Destructive actions must continue to use the existing permission model.

## 5.4 Historical AGY sidecars

Existing old `agy-node.cmd` / `cmd.exe` processes must remain **report-only** unless ownership can be proven.

No broad:

- `taskkill cmd.exe`
- kill-by-name
- kill-by-parent-dead
- kill-by-command-pattern

logic is acceptable.

---

# 6. Remaining Gap — M3 Crash-Safe Process Reconciliation

**Status: PARTIAL FOUNDATION EXISTS, PROCESS LAYER MISSING**

SuperAgent already has job-level restart reconciliation in:

- `cliBridgeReconciliation.ts`;
- CLI Bridge checkpoint/recovery logic;
- DAG reconciliation;
- capacity orphan recovery.

This is useful, but it does not yet reconcile the new Process Registry with live OS processes.

## 6.1 Required startup reconciliation

On startup:

1. load persisted process registry;
2. enumerate relevant recorded PIDs;
3. read current process creation identities;
4. compare against persisted identities;
5. reconcile owner job/session/runtime;
6. classify each process.

Required classifications:

- terminal;
- currently owned/live;
- orphan candidate;
- historical;
- identity mismatch;
- unknown;
- persistent external.

## 6.2 Safety requirement

Restart must never:

- turn unknown work into verified work;
- automatically replay ambiguous mutating work;
- kill an identity-mismatched PID;
- adopt an unregistered process;
- reattach to arbitrary stdin/stdout.

Mutating jobs with ambiguous external effects should remain:

`unknown_outcome_review_required`

---

# 7. Remaining Gap — M4 Verified Completion V2

**Status: STRONG EXISTING BASELINE, V2 CONTRACT MODEL STILL MISSING**

Existing code already has substantial verified-completion hardening:

- typed verification commands;
- artifact evidence;
- permission precedence;
- verifier timeout handling;
- safe verifier environment;
- durable restart semantics;
- AGY transient permission recovery;
- terminal `denied_actions` blocking;
- unverified DAG/reviewer rejection.

Still missing from the new roadmap:

## 7.1 Acceptance modes

Add:

```ts
type AcceptanceMode =
  | "none"
  | "safe-default"
  | "explicit";
```

## 7.2 Safe-default verifier profile

Safe-default may derive checks only from trusted structured repository data:

- expected artifacts;
- known package scripts;
- `git diff --check`;
- bounded file checks;
- typed verifier registry.

It must never execute arbitrary commands copied from:

- agent prose;
- Markdown plans;
- task descriptions;
- generated shell snippets.

## 7.3 User-facing outcome model

Add derived outcome such as:

- `VERIFIED`
- `VERIFIED_WITH_WARNINGS`
- `PROCESS_OK_UNVERIFIED`
- `VERIFICATION_FAILED`
- `PERMISSION_BLOCKED`
- `REVIEW_REQUIRED`
- `FAILED`
- `TIMED_OUT`
- `CANCELLED`

This must remain separate from process state.

---

# 8. Remaining Gap — M5 Central Runtime Resource Monitor

**Status: PARTIAL EXISTING INFRASTRUCTURE**

SuperAgent already has:

`src/core/tools/cliBridgeResourceSampler.ts`

It currently samples:

- CPU usage;
- system memory;
- free-memory percentage;
- SuperAgent process RSS;
- active jobs;
- host pressure.

This means M5 should **extend**, not replace, the existing sampler.

Still missing:

- managed-process aggregate RSS;
- per-managed-process RSS;
- process spawn rate;
- orphan candidate count;
- recent OOM/kill/timeout event window;
- metrics freshness/staleness;
- integration with Process Supervisor ownership data;
- bounded rolling history.

---

# 9. Remaining Gap — M6 Resource-Aware Scheduler V2

**Status: ADVANCED EXISTING BASELINE**

SuperAgent already has:

`src/core/tools/cliBridgeScheduler.ts`

Existing features include:

- dynamic effective slots;
- minimum and maximum slots;
- host pressure response;
- hysteresis/cooldown;
- heavy-job quota;
- per-project quota;
- queue aging;
- priority weighting;
- project fairness;
- admission reason;
- running jobs are not killed when capacity contracts.

Therefore M6 is not a greenfield milestone.

Still missing:

- Process Supervisor metrics as an input;
- persistent sidecars separated from delegate slot usage;
- orphan pressure;
- stale resource sample rejection;
- richer resource classes:
  - memory-heavy;
  - CPU-heavy;
  - browser-heavy;
- provider-specific weighting where useful;
- explicit scheduler status command.

---

# 10. Remaining Gap — M7 Sidecar Lifecycle Optimization

**Status: NOT IMPLEMENTED**

Before adding pooling/reuse, sidecars must be classified as:

1. SuperAgent-owned;
2. provider-managed but observable;
3. unknown/external.

Only category 1 may be reused/pool-managed by SuperAgent.

AGY/Antigravity processes must not be adopted merely because their executable names or command lines match known patterns.

Required future work:

- inventory sidecars;
- record spawn/lifetime/RAM;
- determine supported provider lifecycle APIs;
- add optional pooling only where ownership is explicit;
- add TTL/max-age;
- bind pooled processes to ownership/lease identity;
- prove measurable reduction in spawn churn and RAM.

---

# 11. Remaining Gap — M8 CLI Process Observability

**Status: DIAGNOSTIC API EXISTS; USER-FACING SURFACE MISSING**

Foundation already exists in:

`ProcessSupervisor.getProcessDiagnostics()`

Still required:

## `/status processes`

Show:

- managed process count;
- active/terminal/historical counts;
- orphan candidates;
- total managed RSS;
- oldest active process;
- ownership summary.

## `/doctor processes`

Show:

- stale records;
- owner-dead processes;
- identity mismatch;
- orphan candidates;
- persistent processes;
- unknown sidecars;
- recommended safe action.

## `/status scheduler`

Show:

- configured slots;
- effective slots;
- pressure state;
- queue depth;
- current job classes;
- admission reason;
- resource sample age.

All outputs must preserve workspace privacy boundaries.

---

# 12. Remaining Gap — M9 Permission Intelligence

**Status: PARTIAL**

Already implemented:

- AGY denied tool detection;
- transient denial tracking;
- clean terminal recovery;
- terminal `denied_actions` blocking;
- permission-blocked classification.

Still missing:

- normalized denial history;
- per-tool denial counts;
- per-workspace scoped aggregation;
- recovered vs blocking denial metrics;
- narrow `permissions.allow` recommendations;
- read-only recommendation UI/status.

Permission Intelligence must **never automatically broaden permissions**.

---

# 13. Remaining Gap — M10 Integrated Production Soak Certification

**Status: PARTIAL**

Existing tests already prove important components:

- Windows console-splash regression;
- CLI Bridge process cleanup;
- AGY permission semantics;
- PID reuse handling;
- capacity orphan recovery;
- 100-job slot lifecycle certification;
- restart verifier behavior.

Still missing is a single integrated production certification covering:

- process registration;
- CLI delegate lifecycle;
- shell/background lifecycle;
- cancellation;
- timeout;
- crash;
- restart;
- registry reconciliation;
- orphan detection;
- owned-only reap;
- PID reuse during reap;
- scheduler pressure transitions;
- sidecar classification;
- no stale capacity slots;
- no stale worktree locks;
- no false `VERIFIED`;
- no foreign-process kill.

---

# 14. Priority Recommendation

## Next implementation sequence

### P0-1 — M1 Coverage Completion

Register all remaining **SuperAgent-owned** subprocess families.

Do this before reaper implementation so the supervisor has complete enough ownership evidence.

### P0-2 — M2 Orphan Scanner + Reaper

Implement in two stages:

1. read-only scan;
2. owned-only destructive reap.

Do not enable automatic historical cleanup.

### P0-3 — M3 Process Reconciliation

Connect persisted registry to live process identity on startup.

### P0-4 — M8 Minimum Observability

Expose:

- `/status processes`
- `/doctor processes`

before enabling aggressive cleanup.

### P1 — M4 Completion V2 refinement

Add acceptance modes and `VERIFIED_WITH_WARNINGS`.

### P1 — M5/M6 supervisor integration

Use Process Supervisor data to improve the existing resource sampler/scheduler.

### P1/P2 — M7/M9/M10

Finish sidecar optimization, permission intelligence, and integrated certification.

---

# 15. Recommended Next Worktree

Suggested next isolated branch/worktree:

`agent/runtime-supervisor-m1-coverage-m2-reaper-20261028`

Recommended scope:

1. M1 subprocess coverage completion;
2. M2 read-only orphan scanner;
3. no automatic killing in first implementation slice;
4. process observability API/doctor output;
5. fault-injection tests for PID reuse and stale identity.

Only after this slice is verified should destructive owned-only reaping be enabled.

---

# 16. Final Assessment

The runtime work is in a substantially better position than before Batch 1.

The critical shift is that SuperAgent now has a durable source of process ownership evidence instead of relying on PID/name/parent heuristics.

However, **ownership evidence is not yet equivalent to safe cleanup authority**.

The next certification boundary is:

> SuperAgent can identify, reconcile, and safely clean only processes that it can prove it owns, while leaving historical, reused-PID, provider-managed, and unknown processes untouched.

Until M1 coverage, M2, and M3 are completed and fault-tested, global process cleanup must remain conservative.
