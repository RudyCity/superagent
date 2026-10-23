# Brain README / Release Acceptance Report — 2026-10-23

Scope: SuperAgent and T-Line README command accuracy, offline documentation gates, desktop and remote acceptance evidence. This work does not modify active tunnel servers, install MSI, bypass TLS, or alter unrelated worktree files.

## README fixes
- SuperAgent working-tree Windows launcher guidance is now outside its installation fenced `bash` block. **That Windows launcher guidance and package script are concurrent-session uncommitted changes:** they were preserved and not incorporated into this Brain-only commit. The committed Brain README adds an explanation of automated documentation drift checks.
- T-Line README now uses `RudyCity/t-line`, Bun 1.4.2+, `bun install --frozen-lockfile`, `bun run dev:backend` and `bun run dev:frontend` in separate terminals; explains `bun run dev` starts the CLI instead of both services.
- T-Line README refers to `desktop-tauri` (not old `src-tauri`) and warns that `dev:tauri` invokes `dev.cjs`, which kills listeners on ports 5773/5779 and existing T-Line desktop processes. **Do not run `dev:tauri` on a shared active host.**
- Distinguishes `bun run tauri dev` from the more invasive `dev:tauri`, and documents the production `bun run build:tauri` script.

## Automated documentation drift checks
- SuperAgent: `bun scripts/check-brain-docs.ts` verifies installation fences, README Brain links, actual script examples, Brain help and command references. Optional Windows launcher guidance is validated only if present: the committed main README does not yet contain the concurrent-session Windows launcher note.
- T-Line: `bun scripts/check-brain-docs.cjs` rejects stale paths/clone URL/dev instructions, verifies package scripts, desktop directory, Brain links and autocomplete source.
- Integrated into SuperAgent `scripts/verify-brain-release.ts` including `--with-tline`; SuperAgent `.github/workflows/brain-core.yml`, T-Line `.github/workflows/brain-integrity.yml` and `.github/workflows/release.yml`.
- CI watch paths include README/script edits. Release workflow pins Bun 1.4.2 and frozen dependency install.

## Offline results
- `bun scripts/check-brain-docs.ts`: PASS.
- `bun scripts/check-brain-docs.cjs`: PASS.
- `bun scripts/sync-brain-runtime.ts --check`, `bun scripts/check-brain-runtime.cjs`: PASS.
- Brain unit/MCP tests: 53 passed.
- T-Line backend Brain tests: 14 passed.
- T-Line Brain UI tests: 11 passed.
- SuperAgent Bun/TypeScript build: PASS.
- T-Line backend build: PASS; frontend Vite production build: PASS.
- Initial combined release check connection ended before terminal success message while running frontend; all remaining pieces were run separately and passed. Do not claim that the initial combined invocation itself finished.
- Existing non-blocking Vite CSS warning and large-chunk warnings remain.

## Live status and release blockers
- **MCP public OAuth:** Verified the SuperAgent public Cloudflare endpoint rejects an unauthenticated `GET /mcp` with HTTP 401 and valid `WWW-Authenticate: Bearer` header; public OAuth authorization-server metadata returned HTTP 200. **Authenticated token exchange and MCP tool invocation through the public endpoint were not performed**, so OAuth E2E signoff is incomplete. No active tunnel was restarted.
- **Claude CLI:** installed Claude Code 2.1.148; `claude auth status` reports logged in via the configured API-key helper. Real delegated acceptance failed with `API Error: Unable to connect to API: Self-signed certificate detected`. Neither `NODE_EXTRA_CA_CERTS` nor `SSL_CERT_FILE` was configured when inspected. A trusted corporate/proxy CA certificate must be supplied and validated by the operator; do **not** set `NODE_TLS_REJECT_UNAUTHORIZED=0` or bypass certificate validation. Retest delegation only after trusted CA resolution.
- **T-Line Desktop:** local host reports WebView2, MSVC, Cargo, Rust and Bun available; `bun run tauri info` succeeds. Existing version 1.3.699 MSI/NSIS installers are present from earlier builds. No newly installed/interactive GUI acceptance was completed; no desktop process was killed or replaced.
- **GitHub Actions:** `gh run list --workflow brain-core.yml` and `brain-integrity.yml` returned 404: those workflows are not present on the current remote default branches. Local changes and prior Phase 5/6 commits are ahead of origin; a remote run cannot be claimed until these are pushed and workflows execute. Older, unrelated T-Line release workflows succeeded in July/August but do not validate these changes.
- **Push safety:** SuperAgent has many dirty files from parallel development and both `main` branches contain numerous local commits ahead of origin. Do not push all unpublished work from this documentation task. Keep Brain-only commits local pending coordination.

## Next operator acceptance
1. Confirm the trusted CA chain for the Claude CLI environment; retry small read-only CLI Bridge delegation after fixing the trust store.
2. Perform OAuth browser login/token exchange and a read-only MCP call through the specific SuperAgent tunnel with an authorized testing identity; no copied tokens in logs.
3. Run packaged T-Line in a controlled desktop session that is not using shared ports and verify Brain Explorer + `/brain` and `/scratch` UI flow.
4. Coordinate remote branch/push with the other active workstreams, then verify GitHub Actions on pushed commits.
