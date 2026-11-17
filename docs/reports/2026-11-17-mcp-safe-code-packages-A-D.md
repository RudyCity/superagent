# MCP safe-code packages A–D — implementation evidence (2026-11-17)

## Scope and operating restrictions

GitHub-only changes to `RudyCity/superagent` on canonical `main`.
No local laptop/host files were opened, no running Core/MCP/Tray was signaled,
no tunnel, OAuth secrets, grant database, active session, release tag or
published binary was modified. Parallel agent work was preserved through
per-file GitHub SHA-checked updates.

This report is a **source review and test ledger**, never a release, runtime
attestation or permission grant.

## A — Host file-policy certification

- `registeredFileToolGate.ts` no longer certifies `git_status` as
  unmediated file-safe metadata: repository-configured Git fsmonitor hooks
  may execute unreviewed code or inspect denied paths.
- `superagent_media_plan` remains **read-only**. Its v2 certification checks
  explicit source, watermark and destination-existence paths, and now rejects
  unknown/non-string operations, malformed quality/compression values,
  conflicting target units and a convert-mode/transform-operation conflict.
- `mcpExactFileSearch.ts` retains exact source-file allowlisting, no
  recursive traversal or shell, strict byte caps and cursor pagination;
  rechecks the opened path's real identity and file descriptor metadata
  before returning results to reduce symlink and in-place-change races.
- Tests cover denied Git status and media-plan variants, plus a simulated
  file change between pre/post descriptor checks.

**Intentionally not auto-certified:** arbitrary CLI commands, Desktop Input,
CDP `evaluate`, Android shell, recursive file search, and PDF/media
mutations with implicit output paths. These remain behind existing
per-action host authorization/security reviews; a blanket exception
would violate Permanent File Policy v2.

## B — Security Approval

The existing independent OAuth scopes, MCP Connection Controls, per-project
grants, native host file policy, owner checks, and immediate revocation tests
remain intact. New policy hardening is implemented **without** modifying
any installed grant or enabling Chat Agent YOLO for MCP sessions.

The source policy readiness report explicitly says that a tool's
classification is **not** proof of execution authorization.

## C — Regression and cross-platform reliability

`.github/workflows/mcp-fast-regression.yml` continues to enforce
TypeScript typecheck, emitted Core build, focused MCP protocol/security
regression, and the Windows/Linux/macOS native policy matrix.

The native policy matrix now includes:
- persistent host access policy and Trusted Desktop Input fixtures;
- Android/LAN file queue recovery and relay manager fixtures;
- all existing MCP OAuth, project approval, exact-file grep and Chrome
  bounded metadata acceptance tests.

These are deterministic CI mocks, **not physical Windows input, Android
hardware, tunnel or installed Core/Tray acceptance**. Live owner and
release-digest verifier scripts remain read-only and require attended
approval and matching backend SHA-256.

## D — Non-mutating release readiness

New `src/core/mcp/mcpPolicyReadinessReport.ts` and
`scripts/report-mcp-policy-readiness.ts` compute the active registered
catalog, disabled tool count, per-effect category totals, and the names
that are still uncertified. The report always distinguishes:
`scope: source_catalog_only`, `codeTested:false`,
`runtimeVerified:false`, and `releaseReady:false`.

`tests/mcpPolicyReadinessReport.test.ts` checks complete accounting and
ensures that **no source-only CI result** can claim runtime or release
certification. The workflow prints the report after focused tests and
rejects inconsistent tool classification.

Actual native release requires the existing exact-tag source SHA checks,
six release-build job receipts, asset checksum verification,
installed-host acceptance, authenticated owner identity, and R0–R7 release
gates. No tag or release is created here.

## Commit references and verification

Changes were committed as individually scoped GitHub file updates,
including `c426bfea`, `eb260fd7`, `08f9e876`, `1767b657`,
`8524f495`, `7dd3c931`, `3bb4eec6`, `a86b95a2`, and
`72b0e7ae`. The canonical `main` also receives independent concurrent
agent commits.

The original MCP regression for `1767b657` succeeded:
[run 44054296875](https://github.com/RudyCity/superagent/actions/runs/44054296875).
The source-policy report initially had a TypeScript assertion syntax
failure; `a86b95a2` corrected that. **Do not infer that the latest
integrated matrix passed until the exact newer CI run is completed**;
GitHub has cancelled intermediate runs during concurrent pushes.

## Remaining blockers

1. Live `fast1` connector access is not present in this session; no
   authenticated Core/MCP/Tray session or Windows/Android device can be
   tested from here.
2. Native artifact signing, package integrity, R0–R7, extended soak,
   owner process-birth proof, and operator-approved release/cutover are
   independent gates.
3. Tool operations that can affect arbitrary applications or implicit
   filesystem outputs are **intentionally unapproved** by the safe-code
   certification layer until exact effect mediation is available.

**Completion labels:** source changes IMPLEMENTED; automated tests
PENDING latest run; LIVE RUNTIME BLOCKED; PUBLISHED RELEASE NOT PERFORMED.
