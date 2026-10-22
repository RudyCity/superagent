# SuperAgent Bun security and regression gate — 2026-10-22

## Outcome

- Bun runtime 1.4.2 with `bun install --frozen-lockfile`.
- Replaced runtime `fast-glob` with `Bun.Glob`, including cached glob matching and grep file discovery. Limits on glob nesting and length remain active.
- Replaced `@tailwindcss/cli` and its `@parcel/watcher` chain with `@tailwindcss/node` + `@tailwindcss/oxide` for the extension stylesheet. The generated selector set is substantially equivalent; no Chrome browser rendering test is asserted.
- Converted `ink-text-input`, `mammoth`, and Git-sourced `r-memory` patches to native Bun `patchedDependencies`. Removed `patch-package` and original patch-package patch files.
- Locked graph no longer contains `braces`. On this run `bun run security:bun` returned **pass / 0 high-critical advisories**. The security check remains fail-closed if registry data is unavailable.
- `bun run verify:extension-js` parses 8 extension JS files with `Bun.Transpiler` without executing browser APIs.
- Updated batch-test inventory and CI to Bun-native paths and explicit full-regression security gates.

## Verified checks

- TypeScript build: pass
- Bun native glob and SSH/file-reader focus: 53 tests passed
- Cache interception tests updated to use real scratch files: 7 tests passed across cache and native glob suites
- Native patched dependencies: DOCX, XLSX, JSON Patch, Sharp and RMemory smoke passed
- CLI, API server bearer-token redaction, lifecycle and T-Line isolated bridge smoke passed
- Bun lockfile frozen install: pass
- Bun audit high/critical: 0, pass
- Chrome extension static JS syntax check: 8/8

## Full regression status

Full SuperAgent suite at bounded 4-worker concurrency (before fixing the two stale cache mocks):
- 442 test files: 430 passed, 11 failed, 1 skipped
- 3957 tests: 3936 passed, 16 failed, 5 skipped
- Both glob/grep fallback failures were resolved in targeted reruns after updating tests for Bun.Glob.
- Remaining regressions in context compaction, model config, RMemory migration, skill revision, tooling and Remote Chrome must be investigated before production signoff. Changes to those subsystems are being developed concurrently; do not claim full suite passed.
- T-Line desktop NSIS/WebView2/tray/updater acceptance still requires fresh packaging and installed-app validation.

## Release rules

The Bun security gate and full regression jobs remain mandatory; an unresolved failure cannot be silently waived. A passing lockfile security audit does not certify an installed Windows GUI application. Do not publish a production release until T-Line installed GUI, ownership-safe quit/restart, and agent task E2E are verified.
