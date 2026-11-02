# SuperAgent PR #2 Mainline Takeover Remediation — 2026-11-02

## Scope and repository truth

- Canonical workspace: `D:\backup from pc asus\Documents Development\superagent`
- Branch: `main`; no new worktree.
- PR #2 (`feature/linux-cdp-m1-m3-only-20261029`) remains Draft, non-mergeable, and behind main.
- Key browser takeover modules in PR #2 were verified byte-identical to `main`. Therefore the fixes were made directly on `main`, **not** by merging/rebasing the old PR.
- Existing user-created untracked `artifacts/` was preserved.

## Implemented

1. **P0: Exclusive durable per-target takeover reservation.** Added `takeoverTargetLease.ts`: a hashed `port + targetId` directory acquired atomically, with a strictly owned session marker. A competing claimant is refused. The reservation persists across processes/restarts and is released only after a successful verified `AGENT_ACTIVE` transition. Cancellation, expiry, or ambiguous/corrupt state fails closed and requires operator reconciliation.
2. **P1: Authorized Return to Agent retry.** `requestReturn` accepts valid operator-token retries for `RETURN_REQUESTED`, `VERIFYING`, and `PAUSED_NEEDS_REVIEW`, while keeping remote input revoked and repeating live identity validation. The browser UI restores the Retry button on error. A cancellation is shown successful only after a successful HTTP response.
3. **P1: Public session secret redaction.** `sanitizePublicSession` now strips `csrfTokenHash` and `vncPassword` in addition to invitation/operator hashes.
4. **P1: High-severity dependency audit.** `package.json` Bun overrides pin `body-parser@2.4.0` and `zod@4.6.7`. Only related packages/lock entries changed.

## Verification completed on Windows, Bun 1.4.2

- `bun run build` — pass.
- `bun --bun x vitest run` 12 relevant browser/process suites — **104 tests passed**.
- Integration test of two concurrent same-tab takeover requests, human-hold enforcement, token redemption, verified resume, and subsequent claim — pass.
- `bun install --frozen-lockfile --ignore-scripts` — pass (no lockfile drift).
- `bun run security:bun` — pass, **zero high/critical advisories reported**.
- `bun run runtime:acceptance` — pass (CLI/ProcessPool/SQLite/RMemory, authenticated server, lifecycle, dependencies).
- `bun run verify:extension-js` — pass, 16 JavaScript files.
- `git diff --check` — pass.

## Remaining release gates (not yet certified)

- Full 5,000+ regression test matrix on Windows/Linux.
- Real Ubuntu/Debian Chrome + Xvfb + VNC/noVNC + mobile keyboard/mouse end-to-end certification.
- Cross-tenant OS/network isolation and disconnect/crash chaos matrix.
- Authorized operator reconciliation for fail-closed stale holds and reservations.
- Review other native/standalone browser handoff routes for arbitration with the new M3 target reservation.
- PR #2 should be closed as superseded only after confirming the final mainline fix and desired GitHub process. **Do not merge PR #2.**

**Release verdict: not production-certified.** This work closes a scoped local implementation and test milestone only.
