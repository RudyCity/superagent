# SuperAgent M4-A Windows Full Regression Audit — 2026-11-02

## Scope and evidence

- Workspace: `D:\backup from pc asus\Documents Development\superagent`; branch `main`.
- Base commit at test start: `5f008e1d`.
- Runtime: Windows + Bun 1.4.2 + Vitest 4.1.10.
- A comprehensive alphabetical inventory identified **682 `tests/**/*.test.ts` files**.
- To avoid the previously verified resource timeout and destructive live test effects, every file was exercised in **15 bounded batch/range executions**, with the three unusually heavy CLI Bridge suites run individually and two long batches split further.
- The controlled test processes were launched with `SUPERAGENT_ALLOW_WORKTREE_TESTS=0`, `SUPERAGENT_RUN_LIVE_AGY_E2E=0` and `NO_COLOR=1`.
- A wrapper timeout does **not** count as success: the earlier oversized groups were rerun in smaller groups until exit status `0` was observed.

## Final aggregate (counted once per file)

| File index range | Passed tests | Skipped tests | Result |
|---|---:|---:|---|
| 0–39 | 331 | 0 | PASS |
| 40–99 | 356 | 0 | PASS |
| 100–119 | 209 | 0 | PASS |
| 120–139 | 137 | 17 | PASS, 2 opt-in suites skipped |
| 140–144 | 75 | 3 | PASS: 4 suites run individually, one opt-in suite skipped |
| 145–199 | 475 | 0 | PASS |
| 200–259 | 507 | 0 | PASS |
| 260–319 | 446 | 0 | PASS after MCP test alignment |
| 320–379 | 375 | 0 | PASS after scoped YOLO test alignment |
| 380–439 | 327 | 0 | PASS |
| 440–499 | 757 | 0 | PASS |
| 500–559 | 563 | 3 | PASS |
| 560–589 | 281 | 1 | PASS |
| 590–619 | 172 | 0 | PASS |
| 620–681 | 474 | 1 | PASS |
| **Total** | **5,485** | **25** | **0 failures; 682 files accounted for** |

The initial 560–619 run emitted a passing test summary but did not exit before its wrapper deadline; both 30-file reruns ended with exit `0`. The 100-iteration verification stress case in `cliBridgeVerifiedCompletionHardening.test.ts` took approximately 77 seconds and passed when run separately. `cliBridgeTool.test.ts` (52 tests) and `cliBridgeSessionLifecycle.test.ts` (3 tests) also passed individually.

## Remediation during independent regression

1. `tests/cliBridgeAgyRealMatrixE2E.test.ts`: dedicated real AGY E1–E10 certification now requires `SUPERAGENT_RUN_LIVE_AGY_E2E=1`. The real CLI consumes external capacity and has long bounded waits; it is not part of normal deterministic regression. The existing separate worktree/live test opt-in `SUPERAGENT_ALLOW_WORKTREE_TESTS=1` remains in effect.
2. `tests/mcpGatewayHttp.test.ts`: updated stale four-tool-only assertions. Gateway mode now deliberately preloads **authorized** project/workspace tools. Tests assert the four gateway primitives are present, all extras belong only to the approved eager set, and unauthorized mutations stay hidden.
3. `tests/mcpToolExposure.test.ts`: updated assertions that allowed `superagent_get_workspace` is eagerly visible while `superagent_switch_workspace` remains hidden with YOLO OFF.
4. `tests/motionMcpIntegration.test.ts`: positive write fixtures now explicitly enable **Scoped YOLO**. `allowDangerous` alone does not authorize writes. Scoped YOLO preserves the negative cross-workspace test; Full YOLO would intentionally relax that particular boundary.

No production permission gates were relaxed and no changes were made to the application runtime for these fixes.

## Additional quality checks

- `bun run build` — PASS.
- `bun run security:bun` — PASS with zero reported high/critical advisories.
- No new worktree created; after tests the local branch remains `main`, with remote `origin/main`, `origin/python-mcp-client` and `origin/runtime/reboot-safe-certification-20261027`.
- Existing untracked `artifacts/` is user-owned and has not been staged or deleted.

## Pending production gates

- The 25 skipped tests remain outside this default Windows regression certification. Real AGY and four-worker worktree tests require explicit operator approval and controlled disposable repositories, not the developer's main checkout.
- Linux Ubuntu/Debian Chrome + Xvfb + VNC/noVNC real end-to-end and mobile human takeover.
- Crash, disconnect, stale human hold/lease reconciliation and per-tenant OS/network isolation.
- Cross-platform GitHub Actions matrix and live process/port ownership chaos audit.

**Verdict:** M4-A **PASS for Windows deterministic/batched regression**, production certification **NO-GO** pending M4-B/M4-C and opt-in live tests.
