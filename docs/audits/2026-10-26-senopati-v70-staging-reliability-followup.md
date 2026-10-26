# Shared intent model V7.0 — isolated T-Line staging and reliability follow-up

Date: 26 October 2026
Repository: SuperAgent source on Windows/Bun
Scope: isolated REST/T-Line compatibility, fail-closed owner verification, optional long-run health telemetry.

## Changes

- `senopatiWatchdogStatus.ts` now exports validated `configuredPrecision` from the watchdog's existing private metadata. Unknown/missing precision is represented as null, not silently treated as INT8.
- `senopatiReadiness.ts` projects last-known `healthy` only when the policy's exact precision matches the watchdog's advertised precision and the heartbeat/model owner metadata remain valid. Otherwise it reports `degraded` and the legacy classifier fallback.
- `senopatiLifecycle.ts` refuses an optimistic "already running" decision unless the watchdog heartbeat, mode/precision, authenticated model PID, and owner PID agree. A pure testable helper covers the owner contract.
- `senopati-tline-staging-smoke.ts` uses a fresh loopback port, disposable profile, disabled lifecycle autostart and its own child server process. It checks unauthorized/invalid credentials (401), authorized GET status (200), T-Line backend port-probe compatibility, no model allocation and fail-closed fallback. Accepts `--dist` to test the freshly compiled source build, otherwise runs Bun directly against TypeScript source.
- `senopati-long-soak.ts` is a bounded **read-only** synthetic operational probe with `--seconds` (15–21600), `--interval-ms` (250–10000), `--inference-every` (1–100). It records model/watchdog PID turnover, owner/precision/heartbeat failures, uptime samples, RSS and optional trend (only after at least ten minutes), and measured p50/p95/p99 synthetic inference latencies. It does not restart anything, persist prompts or send notifications.

## Commands

From the SuperAgent repository:

```bash
bun run build
bun scripts/senopati-tline-staging-smoke.ts
bun scripts/senopati-tline-staging-smoke.ts --dist
bun scripts/senopati-long-soak.ts --seconds 20 --interval-ms 1000 --inference-every 4
bun scripts/senopati-long-soak.ts --seconds 3600 --interval-ms 1000
bun scripts/senopati-long-soak.ts --seconds 21600 --interval-ms 2000
bun src/cli.tsx senopati doctor
```

## Results

- Source staging real Bun server: **PASS**, status HTTP `401/401/200`; model phase `degraded` and `legacy-active` fallback in empty staging profile; authenticated T-Line probe compatible; no new model.
- Newly compiled build staging server: **PASS**, same HTTP status and T-Line backend compatibility result. Existing global Core listener was not restarted.
- Bridge smoke using T-Line backend probe: **PASS** with authenticated request, while missing/invalid bearer are classified as occupied, never mistaken for free ports.
- 20-second synthetic live shared-inference probe: 20/20 healthy samples, 6/6 predictions, no ownership/PID changes, RSS 579–580 MiB and final-start increase of 1 MiB, observed inference p95 ~73 ms **on six synthetic requests only**. Not a capacity SLO and not evidence of no long-run memory leak.
- Focused identity, heartbeat, lifecycle, readiness, queue, IPC and authentication suites: **85/85 tests** (10 suites), plus targeted owner tests **36/36** (5 suites). Later build and whole-repository type check passed. These may overlap; do not add their totals as distinct tests.
- Post-probe shared model/watchdog remained healthy, with model PID 10988 and watchdog PID 30908 during this session. Production core/MCP sessions were left running.

## Limitations and release gates

- The installed global Core remains a separate running process and has not been hot-restarted for this source commit. The new status field is validated on actual isolated source and compiled servers, but not confirmed on the already-running global Core.
- No packaged T-Line GUI, live native desktop reconnect across a crash, Windows reboot/login test, full 1–6 hour soak or independent classifier safety approval was completed.
- The empty isolated profile intentionally reports fallback and never spawns its own heavyweight model. This test does **not** simulate killing or stalling the active model owner.
- A momentary syntax issue in another in-progress Core recovery file initially blocked a full build. It was not edited during this task. A later `bun run build` and `tsc --noEmit` passed after concurrent work progressed.
- Classifier status never grants permissions, invokes tools, auto-replays a chat, or authorizes a tunnel restart.
