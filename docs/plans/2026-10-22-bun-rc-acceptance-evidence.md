# Bun Production Release Candidate Gate — 2026-10-22

## Decision: NOT APPROVED

Repositories: RudyCity/superagent and RudyCity/t-line. This document is a point-in-time verification record, not an approval to publish/install an update.

## Verified

- Bun 1.4.2, SuperAgent TypeScript build, CLI/SQLite/RMemory/native worker acceptance, isolated Bun server authentication (401 unauthorized / 200 authorized), process journal cleanup, dependency-compatibility smoke and T-Line isolated bridge contract: PASS.
- Bun security gate: PASS at verification, 0 high/critical advisories; the `braces` dependency chain was removed in commit `53b3d663`. A later security audit remains necessary before actual publication.
- SuperAgent focused regression: 50/50 PASS (seven suites).
- T-Line backend build, frontend build, bundled Bun Windows ConPTY smoke and backend isolated smoke: PASS.
- T-Line NSIS archive verification: PASS when checked against the staged backend; a successful gate does not establish a new NSIS build has finished nor that an installer has been installed.
- Chrome bridge authentication fixture corrected: a handshake frame must not be echoed after becoming authenticated. 7/7 targeted tests PASS; committed as `77f39247`.

## Known failed acceptance

- Local full SuperAgent Vitest suite, with at most three workers, at one checked-out state: 3,961 passed, 12 failed, 5 skipped (450 files total). Failed areas: Chrome bridge test fixture (now fixed), compaction history/concurrency, operational mode switching, pinning strategy, skill-learning memory integration, skill-revision Windows cleanup lock, tool execution and grep limits. Some source files were concurrently under active development while tests ran.
- Prior GitHub Actions workflow at commit `b43d107c`: Ubuntu + Windows runtime matrix and security steps PASS; full regression (Ubuntu): 3,926 passed, 26 failed, 5 skipped. It was not a complete-green workflow.
- Live desktop-installed app, WebView2, tray, updater, signing, antivirus, user session restore, real agent task, cancel/reconnect, soak and multi-tab stress: UNVERIFIED. Isolated loopback contract tests are not substitutes.
- NSIS app release compilation was running at the time of the check; do not claim it produced an updated installer without a successful final build log and artifact timestamp.
- Production credential isolation: bearer token redacted in diagnostics, file handoff and probe verified on isolated port. Real port 7888 was previously probed `compatible` after restart but no user task was submitted from T-Line UI.

## Release conditions

1. Fix remaining independent failing tests; rerun full suite at a stable commit, on Windows and Ubuntu, with reproducible pass and no active concurrent source modifications.
2. Rebuild the installed NSIS from that stable commit; archive gate verifies the newly produced installer; test real WebView2/tray/PTY and in-app SuperAgent prompt/cancel/recovery on disposable Windows installation.
3. Require successful GitHub Actions Bun runtime, full regression and security jobs for the exact release commit.
4. Publish only after signing/updater manifest, smoke, compatibility and security checks succeed. Do not force-commit unrelated in-progress Brain Workspace/Motion Studio/compaction files.

This file intentionally does not claim production release approval or complete user acceptance.
