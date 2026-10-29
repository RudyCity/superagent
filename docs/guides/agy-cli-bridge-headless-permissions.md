# AGY CLI Bridge: verified completion and headless permission recovery

Updated: 2026-10-28

## Completion is two separate facts

CLI Bridge now reports **process execution** separately from **task proof**:

| Process / proof | Meaning |
|---|---|
| `succeeded / unverified` | The CLI exited 0. This is **PROCESS_OK / UNVERIFIED**, not proof that the requested task is correct. |
| `succeeded / artifacts_verified` | Every declared legacy `expectedArtifacts` file was created/changed and SHA-256 inspected. This is **artifact-change proof only**, not semantic correctness. |
| `succeeded / verified` | An explicit `acceptanceContract` passed all required artifact/Git/operator-verifier checks. |
| `verification_failed` | The CLI may have exited 0, but required acceptance proof failed. |
| `permission_blocked` | AGY reported a denied action. Permission denial wins even when AGY exits 0. |
| `unknown_outcome_review_required` | A persisted active-looking job lost trustworthy runtime ownership; effects are not replayed or inferred. |

Human-facing CLI Bridge output prioritizes a `Task outcome` such as
`PROCESS_OK / UNVERIFIED`, `VERIFIED`, `VERIFICATION_FAILED`,
`PERMISSION_BLOCKED`, or `REVIEW_REQUIRED`.

## Public acceptance contract

New background delegations may use `acceptanceContract`:

```json
{
  "action": "delegate.start",
  "cli": "agy",
  "permissionMode": "accept-edits",
  "acceptanceContract": {
    "artifacts": [
      {
        "path": "docs/implementation-report.md",
        "mustExist": true,
        "mustChange": true,
        "minBytes": 200
      }
    ],
    "gitDiff": {
      "maxChangedFiles": 4,
      "prohibitedPaths": [".env", "secrets"]
    },
    "verificationProfile": "cli-bridge-core"
  },
  "prompt": "Carry out the scoped task and produce the declared artifact."
}
```

The public contract intentionally does **not** accept raw build/test shell
commands. `verificationProfile` selects an operator-owned profile from:

```text
~/.superagent-r/cli-bridge/verification-profiles.json
```

Example operator configuration:

```json
{
  "cli-bridge-core": {
    "build": ["bun run build"],
    "tests": ["bun test tests/cliBridgeDelegateJobs.test.ts"]
  }
}
```

The profile is resolved **before AGY starts**. Only its name and SHA-256 digest
are persisted with the job; command text remains runtime-only. Verifier
processes receive a bounded OS/toolchain environment with `extendEnv=false`
so arbitrary provider/API secrets from the parent process are not inherited.

Legacy `expectedArtifacts` remains supported for backward compatibility, but
it yields `ARTIFACTS_VERIFIED / SEMANTICS_UNVERIFIED`, not semantic
`VERIFIED`.

## Permission policy

- `permissionMode="plan"`: planning with default AGY protections.
- `permissionMode="accept-edits"` (default): may accept edits as permitted by AGY, but commands can still need interactive review or an operator-approved narrow allow rule.
- `permissionMode="auto"`: passed to AGY; some accounts do not support it. Do not assume it enables headless execution.
- `permissionMode="full-auto"`: explicit opt-in to AGY `--dangerously-skip-permissions`. The bridge never upgrades to this mode automatically.

When AGY falls back to request-review, a headless tool action needing approval
cannot be approved interactively. A structured `denied_actions` result is
classified as `permission_blocked` even if the process exit code is 0.

## Authorized recovery workflow

1. Call `delegate.get` or `delegate.tail` with the job ID in its original authorized workspace.
2. Inspect the specific denied action and exact operation. Do not re-run the denied operation through an alternate tool.
3. Use an interactive AGY session or have the operator approve a narrowly scoped `permissions.allow` rule.
4. Submit a **new** `delegate.start` request with a new idempotency key. Never auto-retry a past denied mutating job.
5. Prefer an explicit `acceptanceContract`; use legacy `expectedArtifacts` only when file-change evidence is sufficient.
6. Verify `Task outcome`, proof state, tests/build evidence, Git diff, and capacity release.

## Slot and restart safety

Every terminal path releases its owned capacity lease. Stale recovery uses
process presence plus process-start identity; PID presence alone is not proof
of ownership and never authorizes killing a process.

If a persisted job still says `running`/`verifying` but its original bridge
owner can no longer be trusted, the current runtime preserves the historical
process status and projects its completion proof as
`unknown_outcome_review_required`. It does not replay the mutation.

`delegate.health` reports verified/unverified/failed/review-required counts
and host slot occupancy. Host-wide slot warnings deliberately do not expose
foreign workspace job IDs, PIDs, paths, or artifact metadata.

## Verification evidence

Focused tests cover:

- exit 0 without proof remains unverified;
- full acceptance pass/fail;
- legacy artifact compatibility;
- raw verifier-command rejection;
- verifier environment secret isolation;
- permission denial precedence;
- Git-diff constraints;
- persisted proof metadata;
- restart review projection;
- cross-workspace privacy;
- 100 sequential terminal jobs with zero capacity leaks.

A real AGY certification run on 2026-10-28 completed **E1–E10: 10/10 PASS**
without `full-auto`. It covered real AGY process-only completion, legacy
artifact proof, full semantic verification, forced verifier failure, missing
artifact failure, real headless permission denial, four concurrent AGY
delegations, and cross-workspace isolation. Timeout/cancel and stale-restart
cases use deterministic bridge fixtures because they test bridge lifecycle
rather than provider intelligence.

Canonical evidence:
- `tools/dev/certifyCliBridgeAgyVerification.ts`
- `tests/cliBridgeAcceptance.test.ts`
- `docs/audits/2026-10-28-agy-cli-bridge-verified-completion-certification.md`

Do not restart the production Core/MCP merely to install this source change.
Use the established authorized deployment/restart process after review/merge.
