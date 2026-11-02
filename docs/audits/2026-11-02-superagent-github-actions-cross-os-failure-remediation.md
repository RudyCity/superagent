# SuperAgent GitHub Actions Cross-OS Failure Audit — 2026-11-02

## Evidence from GitHub Actions (not local guesses)

Repository: `RudyCity/superagent`; starting branch `main` at `af2c6e01`.

- [Bun Runtime Validation run 41427344279](https://github.com/RudyCity/superagent/actions/runs/41427344279), latest examined commit `af2c6e01`:
  - Bun runtime on `windows-2025` **PASS**
  - Bun runtime on `ubuntu-24.04` **PASS**
  - Dependency high-critical security gate **PASS**
  - Full regression on `ubuntu-24.04` **FAIL**: **9 failed, 5,481 passed, 38 skipped tests, and 122 uncaught errors** (from approximately 685 suites)
- [Core Guardian run 41417991685](https://github.com/RudyCity/superagent/actions/runs/41417991685):
  - `ubuntu-24.04` PASS
  - `windows-2025` FAIL on `tests/mcpProcessBirthR1.test.ts` because PowerShell process birth query returned fail-closed `unverified`, which the test rejected.

The latest regression had previously been red across multiple pushes, so the errors are not specific to Linux browser takeover commits.

## Root causes and bounded remediation

1. **Linux tasks invoking Windows `taskkill`:** `spawnHiddenTaskkill` was called from CLI bridge cleanup even on Ubuntu. ChildProcess emits `ENOENT` asynchronously; a surrounding `try/catch` cannot catch that event. Fix: return null/false on non-Windows, plus an asynchronous `error` listener on Windows to ensure a missing executable never crashes the process. No foreign PID is signalled by this change.
2. **Windows-only test assertions running against Linux filesystem semantics:** Expected Windows case-insensitive path resolution, rename retries, and Windows-headed launch diagnostics under Ubuntu. These named tests are conditionally run on Windows, while their suites' POSIX-relevant tests still execute on Linux. An explicit **Windows-only additional CI step** retains coverage for the affected suites on the `windows-2025` job; these suites are not globally excluded.
3. **Platform-independent redaction bug:** `sanitizeProcessCommand` incorrectly persisted a full Windows-format executable path when called on Linux because POSIX `path.basename` does not split backslashes. Fix applies both POSIX and Win32 basename parsing (privacy preservation).
4. **Linux Chrome detection test assumed all browser candidates had been probed:** Discovery correctly stops after the first found binary. Test now verifies every probed path was canonical and only requires exhausting all candidates when no binary is installed.
5. **Virtual desktop package test assumed PATH="" makes /usr/bin binaries disappear:** System package probing intentionally searches standard directories independently of PATH. Assertions now compare detection to actual installed package presence while requiring precise missing-required diagnostics.
6. **Windows Core Guardian PID birth test:** Permission-constrained PowerShell queries legitimately return `unverified`, a fail-closed value that must never authorize ownership. The test accepts this result while other deterministic birth-time tests continue verifying that mismatched timestamps never match.

## Verification of first remediation push and follow-up CI findings

After commit `88e01729` was pushed, [Bun Runtime Validation 41439013118](https://github.com/RudyCity/superagent/actions/runs/41439013118) showed:
- Windows runtime (including new Windows-only step): **PASS**.
- Ubuntu runtime: **PASS**.
- Dependency security: **PASS**.
- Full Ubuntu regression: **5,478 passed, 49 skipped, 1 failed**, zero unhandled taskkill errors. This is a separate performance-sensitive test, `studioCodeVideoDurableJobs.test.ts`, with a hard-coded 10-second polling cap while Chrome/FFmpeg render in a 4-worker concurrent regression. We extended its bounded poll to 45s, report the final job status on timeout, and extended the test's own deadline without changing the job's expected terminal `completed` status.

[Core Guardian 41439013071](https://github.com/RudyCity/superagent/actions/runs/41439013071) showed all 112 Windows unit tests passing, but the owned staging fault-injection failed on an out-of-date scenario: it expected unconditional refusal after the original workers died. The current audited cold-start policy instead permits *verified, evidence-clean archival and fresh start*. The remediation inserts a canonical **accepted-but-unreconciled turn receipt** in the temporary staging profile before total-worker-loss injection. This makes `operator_review` mandatory and verifies that boot refuses to replay work, without weakening the production cold-start policy. `bun scripts/verify-core-guardian.ts` then **PASS** locally, including the full staged crash/recovery path.

## Verification performed

- Windows local TypeScript build: PASS.
- 10 selected suites with the previously failing Windows/cross-platform areas: **133 tests passed, 0 failed**.
- Workflow YAML parsed and original four CI jobs plus additional Windows-only platform regression step checked.
- Exact on-GitHub verification after push to be recorded separately. A local Windows pass cannot prove Linux GitHub Actions pass.

## Safety

- Retained Windows-specific functional tests; did not disable the entire Linux regression.
- No new worktrees or branches; preserved user-owned `artifacts/` outside Git.
- No changes to takeover authentication, VNC exposure or process ownership checks.
