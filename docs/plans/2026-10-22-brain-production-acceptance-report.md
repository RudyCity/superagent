# Brain Production Acceptance — 22 October 2026

## Verified in this implementation
- Canonical SuperAgent Brain Core is synchronized with the generated T-Line backend modules; both source-diff and SHA-256 manifest checks pass.
- SuperAgent and T-Line backend/frontend builds pass using Bun.
- 34 SuperAgent Brain/MCP tests, 11 T-Line backend tests, and 4 T-Line Brain Explorer UI tests pass together through `bun scripts/verify-brain-release.ts --with-tline`.
- OAuth HTTP loopback tests confirm token scope/identity separation with compact MCP gateway discovery.
- Two active MCP tunnel instances were observed via service metadata. The unauthenticated local MCP probe previously returned HTTP 401. This proves no more than local unauthenticated request rejection.
- AGY real CLI delegated into an isolated Brain scratch, completed with `succeeded` + `artifacts_verified`, and promoted its SHA-256 verified artifact. Smoke session: `smoke_82075eda779d51`; job `clj_1792654587519_f60fc343`.
- CLI Bridge health before smoke showed zero active jobs.
- Privacy-safe Brain metrics were implemented. `superagent_brain` action `metrics`, CLI `/brain metrics`, and T-Line `GET /api/superagent/brain/metrics` summarize seven days of allowlisted operation types, outcome flags, and duration only. No prompts, tokens, artifact contents, session IDs or filesystem paths in telemetry rows.
- T-Line release workflow now gates release builds on Brain integrity, backend API tests, and UI tests. Dedicated cross-platform Brain workflows are added to SuperAgent and T-Line for push/PR checks. A passing local test does not prove GitHub Actions has run.

## Remaining operational exceptions
**Claude real CLI:** The standalone acceptance command started `clj_1792654617405_23ab1f9c` in Brain session `smoke_468cdb7e312b28`, but no verified artifact arrived within the bounded runtime. Cancellation was requested. A subsequent read-only CLI Bridge recovery diagnostic reported `cancelling`, owner PID absent, child PID absent, `requiresManualReview=true`. No unverified lock was stolen and no unrelated process was terminated. Investigate Claude credentials/runtime/interactive permission requirements before retrying. Do not label this execution successful.

**Live public OAuth tunnel:** Did not restart either active MCP tunnel or extract user OAuth credentials. An authenticated end-to-end round trip through the *configured public tunnel* remains to be performed by a permitted client after controlled restart/reconnect. The loopback OAuth test is passing but is not an equivalent live-tunnel proof.

**Packaged T-Line desktop:** No running T-Line/Tauri desktop process was found in the process probe. Browser UI tests and backend loopback HTTP tests passed, but packaged desktop interaction has not been observed.

**Warnings outside Brain:** The existing T-Line frontend build emits CSS minification, dynamic import, and large bundle warnings. Build exits successfully; these warnings were not introduced as Brain regressions and need separate UI/build review.

## Operator acceptance steps
1. Schedule a maintenance window and identify the active tunnel to be updated. Verify the correct workspace, not the unrelated active tunnel; restart/reconnect it without affecting another session.
2. Log in with legitimate OAuth MCP credentials through the approved client. Use `superagent_tool_search` to discover Brain (compact gateway mode), then check `current`, `storage`, `metrics`, a small test artifact, and `transfer.status` after reconnect. A read-only second principal must not see another principal's files.
3. Start packaged T-Line desktop; authenticate, navigate SuperAgent → Brain, inspect the expected local-cli namespace, upload a small artifact, preview and confirm an explicitly approved cleanup of a disposable scratch, and inspect Metrics.
4. Diagnose the preserved Claude job in read-only mode (`delegate.recovery` / `delegate.tail`). Confirm any unowned child processes are absent before making operator-approved cleanup changes; rerun smoke after fixing the root cause.
5. Once all above pass, review checkout and release workflow results on both repositories, then deploy.

## Repeatable commands
```bash
# SuperAgent repository
bun scripts/verify-brain-release.ts --with-tline
bun scripts/brain-live-cli-acceptance.ts agy
bun scripts/brain-live-cli-acceptance.ts claude

# T-Line repository
bun scripts/check-brain-runtime.cjs
```

The live CLI scripts create only new temporary Brain sessions outside all Git worktrees; they may consume external LLM credits and are intentionally **not** run by CI. They enforce bounded execution and request cancellation on timeout, but host process exit does not prove a detached child has been fully terminated.
