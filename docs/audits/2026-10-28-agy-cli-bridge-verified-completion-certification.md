# AGY CLI Bridge Verified Completion — Local Certification Evidence

**Date:** 2026-10-28  
**Branch:** `fix/agy-verified-completion-20261028`  
**Base:** `bd731373133e61ee2379851b79cfe24a5a0bec31`  
**Environment:** Windows development host, Bun 1.4.2, installed Antigravity CLI  
**Permission policy:** **no `full-auto` used**  
**Verdict:** CLI Bridge verified-completion hardening passed the scoped local certification matrix.

## What was certified

The certification distinguishes an external CLI process exiting successfully
from a task whose declared acceptance evidence has actually passed.

The public contract supports:

- bounded artifact requirements (exist/change/min-size/optional SHA-256);
- Git-diff limits and prohibited paths;
- operator-owned build/test `verificationProfile`;
- explicit `verified`, `verification_failed`, `permission_blocked`,
  `unverified`, and review-required outcomes.

Raw verifier commands are intentionally not accepted through the public
`acceptanceContract`. Operator verifier commands are resolved before the
agent launches, only their name/digest are persisted, and the verifier uses an
allowlisted environment with `extendEnv=false`.

## Real AGY E1–E10 matrix

Executed with:

```powershell
bun tools/dev/certifyCliBridgeAgyVerification.ts
```

Observed:

| Case | Scope | Result |
|---|---|---|
| E1 | real AGY exit 0 without acceptance proof | **PASS** — `succeeded/unverified` |
| E2 | real AGY + legacy changed artifact | **PASS** — `succeeded/artifacts_verified` |
| E3 | real AGY + artifact + trusted verification profile | **PASS** — `succeeded/verified` |
| E4 | real AGY exits 0; trusted verifier intentionally fails | **PASS** — `verification_failed/verification_failed` |
| E5 | real AGY exits 0; required artifact missing | **PASS** — `verification_failed/verification_failed` |
| E6 | real AGY command requires approval in headless mode | **PASS** — `permission_blocked/permission_blocked` |
| E7 | deterministic bridge timeout + cancellation | **PASS** — neither can become verified |
| E8 | deterministic persisted stale active-looking job | **PASS** — `REVIEW_REQUIRED`, no replay |
| E9 | four concurrent **real AGY** plan-mode jobs | **PASS** — all completed independently, zero leaked capacity slots |
| E10 | cross-workspace lookup of a real AGY job | **PASS** — hidden as not found |

Summary emitted by the harness:

```text
PASS E1: succeeded/unverified
PASS E10: Error: delegation job not found in the authorized workspace.
PASS E2: succeeded/artifacts_verified
PASS E3: succeeded/verified
PASS E4: verification_failed/verification_failed
PASS E5: verification_failed/verification_failed
PASS E6: permission_blocked/permission_blocked
PASS E7: timeout=timed_out/timed_out cancel=cancelled/cancelled
PASS E8: Task outcome: REVIEW_REQUIRED
PASS E9: succeeded/unverified;succeeded/unverified;succeeded/unverified;succeeded/unverified
SUMMARY 10/10 passed
```

The generated raw JSON report for this run was written under
`build/reports/` and is intentionally treated as local generated evidence,
not a source-controlled runtime dependency.

## Focused and regression evidence

Focused verification:

```text
45 pass
0 fail
317 expect() calls
```

covered acceptance contracts, existing delegate jobs, recovery, persisted job
retention, and unified-channel projection.

Every `tests/cliBridge*.test.ts` file then passed when executed sequentially
in its own Bun invocation. Sequential execution is intentional because several
legacy test files mutate process-global capacity/config environment variables;
a parallel glob run can make those tests contend for each other's isolated
capacity directories. That parallel-test interference was not treated as a
product pass.

`bun run build` also passed after the source changes.

## Additional security regressions

Tests explicitly proved:

- caller-supplied raw verifier fields such as `commands` are rejected;
- a missing operator verification profile rejects the job **before child spawn**;
- verifier command text is not persisted in job shards;
- a test secret present in the parent process is absent from the verifier environment;
- a denied AGY action dominates an otherwise changed artifact;
- legacy artifact proof is not projected as semantic `verified` in the unified channel;
- a privacy-safe host-capacity warning does not leak a foreign job ID or PID;
- 100 sequential terminal unverified jobs leave zero occupied capacity slots;
- stale persisted active-looking jobs become in-memory
  `unknown_outcome_review_required` while historical raw process state remains
  unchanged.

## Boundaries

This certification does **not** claim:

- production Core/MCP has been restarted onto this worktree;
- unrelated DAG/reviewer runtime milestones are complete;
- legacy Brain artifact promotion has been redesigned;
- `full-auto` is safe as a default;
- a provider's natural-language "done" message is proof of task completion.

The implementation remains in the isolated worktree until reviewed/merged
through the normal repository process.
