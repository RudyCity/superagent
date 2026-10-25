# SuperAgent Studio — 2026-10-25 recovery, migration, and release follow-up

## Verified-copy cutover completed on 2026-10-25 (supersedes earlier rename blocker)

The physical atomic Windows rename remains unavailable because Explorer and the
Antigravity language server hold directory handles, but the workspace now uses
**.superagent/studio as its canonical storage**. The original
**.superagent/motion stays intact as a rollback copy**. No active application or
tunnel was killed. This is a verified logical cutover, not destructive removal.

- Operator command: `bun src/cli.tsx studio migrate --apply --verified-copy --workspace . --json`.
- Migrated 278 files, **27,349,835 bytes** with source-before, target and source-after
  SHA-256 inventory matching: `74902d0bb549673baf79c545f0e81e32c24342685e62f304f1c21679359796f0`.
- Cutover marker: `.superagent/.studio-verified-copy.json`.
  Without a valid marker, concurrent old/new namespaces still fail closed.
- Post-cutover CLI: `studio migrate` returns `already-studio`, zero blockers.
  `studio storage` returns 46 jobs: **45 completed**, 1 interrupted,
  0 queued/running/failed; 2 free render slots.
- Studio project list: **47** project records readable.
- Independent source/target comparison: same 278 relative paths, zero hash
  mismatches; all **45 completed MP4** files pass FFprobe (650.57s combined).
- Build passed and the Studio test suite plus 22 focused migration/recovery tests passed.
- Archive still available: `.superagent/studio-legacy-pre-migration-20261025.tar.gz`.
- Important: long-running clients with an old in-memory storage implementation
  must refresh before writing; do not delete the old tree while Windows holds
  directory handles or before rollback retention policy is agreed.
- No installed T-Line/Antigravity UI interactive render E2E was performed by
  this storage migration. Release approval is separate.

## Earlier findings (historical, prior to verified-copy cutover)

## Implementation completed

- Added `studio recover-worker JOB_ID --ack-stale --expected-pid PID` for operator-initiated abandoned-worker reconciliation.
- Enforces exact PID, job and project identities, immutable source hash, claim timestamps, only one owned slot, no competing cancellation/dispatch claim and no MP4 or partial output.
- Verifies owner PID absence twice, archives original claim contents and metadata in `jobs/recovery-history`, records terminal interrupted status and preserves the original job snapshot.
- Added token-verified release of the recovery lock. Normal recovery still fails closed.
- Improved Windows atomic namespace migration errors: preserves the legacy tree and reports possible external directory handles without attempting dangerous fallback copies.
- Added 4 new regression tests for wrong PID, live PID, partial output preservation, successful audited reconciliation.

## Workspace recovery outcome

- Source workspace: `D:\backup from pc asus\Documents Development\superagent`
- Recover-worker target: `studiojob-4139b19ce4c16c79224a7795`; PID 44268 absent on Windows.
- Four claims matched and were archived in `.superagent/motion/jobs/recovery-history`.
- Final render storage: 46 job records, 45 completed, 1 interrupted, 0 queued, 0 running, 0 failed, all renderer slots free.
- Backup created before recovery: `.superagent/studio-legacy-pre-migration-20261025.tar.gz`, 20,996,560 bytes, SHA-256 `d5dda1d6aea7d72308d35e60b8864735ac7a028fa9b18aec32f6e76126b8c653`; 335 archive entries.
- Read-only migration inspector: `state=legacy`, zero blockers.

## Unresolved Windows migration

The actual atomic rename `.superagent/motion` → `.superagent/studio` failed with `EPERM` under Bun and WinError 5 under Python. A Windows File Explorer window was browsing the old `motion/renders` folder. It was navigated to the workspace root, but rename continued to fail. Permissions to rename a new control directory inside `.superagent` succeeded. No unsafe copy+delete fallback was used, and the Studio namespace was not partially created.

Migration remains pending release of an unidentified Windows directory handle or equivalent denial. Existing Studio operations continue to use legacy storage safely. Do not force-delete folders or create both namespace roots simultaneously.

## Verification

- SuperAgent build: `bun run build` passed.
- Focused recovery regression: 25/25 passed.
- Full Studio suite: **307 tests passed across 61 suites**.
- T-Line frontend and backend builds passed, including an updated staged production dependency payload.

## T-Line production readiness

The standalone Windows T-Line package had a high-severity advisory for `body-parser` GHSA-27r3-jxmh-p828 (CVE-2026-111181, patched 1.20.9 on the Express 4 branch).

T-Line backend `package.json` now pins `body-parser` at 1.20.9 with an override and the committed desktop backend Bun lockfile is regenerated from an isolated dependency resolution workspace. The staged backend was rebuilt using `bun install --frozen-lockfile --production`. A fresh Bun audit returned `{}` and the release gate marks `production-backend-dependencies=pass`.

Other release gates remain open: the currently existing Windows NSIS installer does not match the newly staged backend package; packaged Windows Bun/ConPTY E2E, installed Tauri auth and playback, Piper, model vision, and extended render reliability still require real packaged validation. Do not label this production ready merely because the source tests pass.

## Next gated tasks

1. Resolve the Windows handle preventing atomic rename; then rerun the migration CLI and verify hashes and completed MP4 playback.
2. Rebuild a Windows Tauri installer from the new pinned bundle; verify the signed/packaged runtime and a real installed Studio E2E before release.
3. Perform a controlled refresh of the long-lived MCP service, preserving active tunnel sessions; confirm the MCP diagnostics match source CLI diagnostics.
4. Keep this report, archive SHA, and recovery-history evidence for later audit. Avoid destructive storage cleanup.
