# Delegate-CDP Action Diagnostics & Reliability — 2026-11-12

## Objective
Make SuperAgent's Chrome Delegate-CDP action results observable, accurately classified, and safe to reconcile after uncertain outcomes. Preserve existing MCP schemas, session ownership, and unrelated dirty work.

## Root-cause boundary
The response `This tool call was blocked by OpenAI's safety checks` is an upstream tool-invocation rejection, observed before the SuperAgent handler executes. SuperAgent cannot prove or classify that rejection from inside its own process, and this project must not bypass, disguise, or retry around OpenAI safety controls. Healthy Delegate transport does not imply upstream action permission.

## Phases and acceptance gates
| Phase | Work | Gate |
| --- | --- | --- |
| P0 | Code-based error taxonomy; bounded, redacted action trace with operation ID, duration, transport/profile fingerprint, command and outcome | No raw token, URL, DOM, typed text, cookie, or error message in traces |
| P0 | Separate `executed`, `verified`, `failed`, and `unknown`; never conflate a click with successful publication | Tests establish click is only executed, not verified |
| P1 | Safe retry for read-only operations only, manual reconciliation for uncertain side effects | No automatic replay of click/submit/post/navigation |
| P1 | Honor the existing exact target identity, lease, capability, and revision fences | Existing Delegate principal/lease tests remain passing |
| P2 | Read-only Tray diagnostics using authorized session scope; opt-in monitoring UI | Implemented in source; 102 related tests passed, native release activation pending |

## Error taxonomy
`INPUT_INVALID`, `PERMISSION_DENIED`, `DISCONNECTED`, `TARGET_MISSING`, `LEASE_CONFLICT`, `LEASE_EXPIRED`, `TIMEOUT`, `EXECUTION_FAILED`. An upstream OpenAI rejection is **not observable inside the SuperAgent CDP handler**. Unknown codes are generic, never inferred from arbitrary free-form messages.

## Verification and retry contract
- A successful CDP click or input dispatch means **executed**, not confirmed to have produced a website-side effect.
- `verified` is reserved for evidence-producing read/verification commands; website publication requires separately observed application evidence.
- The transport never replays a side-effecting command after disconnect, timeout, or ambiguous outcome. Operators must reconcile the live browser state.
- Read-only commands may be retried by callers only after the existing session and authorization checks.
- Each trace stores only allowlisted metadata, with a bounded in-memory ring and optional sanitized diagnostics logging.

## P2 implementation and rollout boundary
- Existing authenticated localhost Tray status routes now return a bounded, metadata-only `actionDiagnosticsStatus` and `actionDiagnostics` projection. MCP principals get unknown/empty diagnostics.
- Only connected Delegate profile fingerprints are eligible; exact profile filters are honored. No URL, DOM, typed text, cookie, bearer token, or raw client ID is exposed.
- Chrome Delegate Tray has opt-in **Show activity** / **Hide activity** controls (hidden by default), stale/unknown states, counts, duration, error category and short operation IDs. All values are rendered using text nodes.
- Live read-only smoke: Eiyogen transport healthy, four normal browser targets (including Threads) detected, no active Delegate lease. No browser click or website submission was attempted.
- Installed Core/Tray must not be assumed updated merely because source tests pass. Activation needs a verified fresh build and guarded ownership/lease checks, without interrupting other active work.

## Validation
- `bun test tests/delegateCdpActionDiagnostics.test.ts tests/chromeCdpDualTransport.test.ts tests/delegateMcpPrincipalBinding.test.ts`
- `bun test tests/chromeCdpTools.test.ts tests/delegateCdpExtension.test.ts`
- `bun --bun x tsc --noEmit`
- Review `git diff` and verify no unrelated modifications have been overwritten.

## Rollback
Revert only newly introduced diagnostic files and the isolated instrumentation patch after reviewing their exact diff. Do not reset, clean, or restore the shared dirty checkout. Preserve existing sessions and refrain from automated service restarts.

## Evidence state
2026-11-12 verification:
- New targeted diagnostics, dual-transport and principal-boundary tests: **20 pass / 0 fail** via native `bun test`.
- CDP and extension regression tests: **78 pass / 0 fail** via native `bun test`.
- `bun --bun x tsc --noEmit`: **exit 0**.
- `git diff --check`: **exit 0** (unrelated extension popup line-ending warning).
- The alternative `bun --bun x vitest run` invocation failed before collecting tests, at `tests/setup.ts:72` (runner not initialized, 0 tests run). Use native `bun test` for the verified test results; do not misreport that runner initialization failure as a failed assertion.
- P2, profile-scope and opt-in Tray UI tests included: **24 pass / 0 fail** (5 test files).
- Existing Chrome CDP/extension regression tests: **78 pass / 0 fail** (2 files).
- Combined latest suite: **102 pass / 0 fail**; `bun --bun x tsc --noEmit` and `node --check apps/superagent-tray/ui/delegate-multitab.js` both exit 0.
- The shared checkout `git diff --check` exits 1 due to an unrelated concurrent `walkthrough.md:1151` blank line at EOF. That file was deliberately left unchanged.
- `bun run build` completed **exit 0**, Core build digest `6d79b3da829c2954d3ddf464902467e9341133427bf9bd408f508044a8787eaf`, 895 compiled files.
- `git diff --check -- src/core/delegate/cdpTransport.ts src/core/delegate/delegateStatusProjection.ts apps/superagent-tray/ui/index.html apps/superagent-tray/ui/delegate-multitab.js` returned **exit 0** (line-ending conversion warnings only).
- Supervisor status after build: the active Core worker reported a build digest equal to the latest Core build and `affinitySessions=0`. This confirms matching compiled-build identity, **not** a native Tray UI release or an end-to-end post/submit verification.
- No commit, push, or operator-driven runtime restart was performed in this implementation. Source and tests are complete; native installed Tray UI remains to be certified through its release process.
