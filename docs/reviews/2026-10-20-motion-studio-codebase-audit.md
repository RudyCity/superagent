# Motion Studio — Independent Codebase Audit (2026-10-20)

## Scope and method

Read-only inspection of SuperAgent `main` at `b6802053`, repository plan, Motion engine, CLI, MCP, HTTP integration, job scheduling, image/audio pipeline and Motion tests. Executed focused Motion Vitest tests, TypeScript validation, CLI doctor, FFmpeg/ffprobe availability, unauthenticated live API probes and MCP read-only list. T-Line source was **not independently opened**: desktop status below is sourced from the implementation plan and must not be mistaken for live Tauri certification. No Hermes agent/server restart or source edits.

## Verified baseline

- Workspace: `D:\backup from pc asus\Documents Development\superagent`, branch `main`, HEAD `b6802053`.
- `npx vitest run tests/motion --reporter=dot`: **11 suites / 45 tests passed**.
- `npx tsc --noEmit --pretty false`: **passed**.
- CLI doctor from source: `mp4: true`, `desktopEditor: false`, `renderJobs: foreground-and-detached-local`.
- FFmpeg and FFprobe: **8.1** available.
- Live background server: **online on port 7888**. Without a token, `/api/motion`, `/api/motion/projects`, and `/api/motion/scheduler` each returned **HTTP 401** as expected. Authenticated round-trip **not performed**.
- MCP `superagent_motion_list` and `superagent_motion_jobs`: returned `[]` in selected workspace; the exposed read path works, but create→edit→render across real remote client was not performed.
- Git worktree had existing untracked `.superagent/` before and after audit; not modified intentionally.

## Feature inventory

| Surface | Observed state | Evidence |
| --- | --- | --- |
| Scene schema + revision CAS | Implemented; tests pass | `schema/types.ts`, `schema/validation.ts`, `project/revisions.ts`, `project/projectStore.ts` |
| Text, rect, image layer; x/y/opacity/rotation tracks | Implemented | `schema/types.ts`, `timeline/evaluateFrame.ts` |
| PNG/JPEG/WebP intake (normalized PNG) | Implemented + tested | `assets/motionAssets.ts`, `tests/motionAssets.test.ts` |
| PCM16 WAV intake, up to 4 tracks, gain/fades and AAC export | Implemented + tested | `assets/motionAudio.ts`, `render/ffmpegEncoder.ts`, `tests/motionAudio.test.ts` |
| 96-bucket waveform endpoint | Implemented + tested | `assets/motionWaveform.ts`, `motionRoutes.ts` |
| H.264 MP4 foreground/detached export and checksums | Implemented + tested | `jobs/motionJobs.ts`, `render/ffmpegEncoder.ts` |
| Bounded queue admission / renderer slots | Implemented, **not a durable FIFO broker** | `jobs/renderScheduler.ts` |
| CLI `superagent motion`, terminal `/motion` | Implemented, limited feature parity | `commands/motionCliHandler.ts`, `commands/motionCommand.ts` |
| MCP 9 tools | Registered; read-only list verified live | `mcp/tools/motionMcpTools.ts` |
| Workspace-scoped HTTP & Range MP4 | Implemented, tested with synthetic server; live no-token auth gate verified | `motionRoutes.ts`, `tests/motionRoutes.test.ts` |
| Native T-Line editor + timeline | Implementation plan records commits and frontend regressions, but **not independently verified this audit** | `docs/plans/2026-10-20-superagent-motion-studio-implementation-plan.md` |

## Prioritized findings

### P0 — End-to-end release verification absent
The canonical plan explicitly reports no packaged/live Tauri→current SuperAgent API complete smoke, no shared project revision/artifact parity certified across Desktop/CLI/MCP, and no full device A/V or multi-track sync certification. Without this, successful engine tests do **not** establish readiness for users. Run a controlled, authenticated end-to-end test against a matching deployed server, preserving ongoing Hermes work.

### P1 — CLI and MCP media-authoring parity is incomplete
`motionCliHandler.ts` offers create/list/inspect/edit-text/frame/render/jobs/status/cancel/recover, but no CLI upload/import for image or audio, layer CRUD, property and track editing, or a bulk JSON semantic edit entrypoint. `/motion` exposes an even narrower interactive subset. The nine MCP Motion tools expose a generic semantic `edit` but no image/audio import operations; imports are available over HTTP. A terminal/agent-only user thus cannot fully author media projects through a single coherent surface. Add scoped import & transactional edit verbs to CLI/MCP and test cross-surface equivalence.

### P1 — Render failure recovery and durability are intentionally constrained
`renderScheduler.ts` admits at most 12 queued jobs and 1–4 renderer slots; waiting is handled by processes and currently capped at 15 minutes. On worker/process crash, fail-closed filesystem claims can block future work until explicitly inspected/reconciled. CLI stale recovery exists, but there is no durable queue broker, verified process identity auto-recovery, requeue, or restart continuity benchmark. This is the right safety default, but not an unattended production pipeline.

### P1 — Export profile is preview-class, not full production output
`deriveRenderProfile()` caps width at 1280, height at 1280 and frames at 1800 (e.g. **60 seconds at 30 fps**). 1920×1080 output is therefore unsupported even though the default composition metadata is 1920×1080. Long-form, full-HD product exports, performance, and memory budgets still need work.

### P2 — Studio capability/metadata flags are stale or ambiguous
CLI `doctor` unconditionally returns `desktopEditor: false`; HTTP root advertises `studio: false`; slash/CLI help still says `foundation preview`. This conflicts with documented native T-Line implementation if interpreted as a global capability check. Define explicit per-surface capabilities (`nativeTLineEditor`, `standaloneBrowserEditor`, `mediaImport`, `renderFormats`) and report them accurately rather than one ambiguous boolean.

### P2 — Creative and editing scope remains limited
Schema supports only rectangle/text/image layers, 4 animatable numeric properties and 3 easing modes; no video clip layer, multi-scene composition, masks, vectors/shapes, path motion, typography/font parity certification, rich transitions, advanced audio mastering, or 1080p/4K export. These are product limitations, **not assertions of code defects**.

### P2 — Test gates are not the same as certification
`motionVisualParity.test.ts` exercises rectangle-only parity for three fixed frames at 160×90. It does not certify real font fallback/layout, randomized cross-platform text/image parity, Tauri preview, long frame sequences, 30-second mixed soundtrack A/V drift, crash/fault injection, or headless packaging. Author reproducible fixtures and automate CI quality/performance thresholds.

### P3 — Media lifecycle and observability
Image/audio stores have integrity controls but no full browser/search/cleanup lifecycle. Job state is file-backed; add bounded retention, orphan diagnostics, per-job metrics and non-invasive admin observability before large-scale use.

## Proposed execution order

1. **P0 integration:** register/authorize T-Line for independent source and test access; coordinate version alignment without restarting active Hermes sessions; verify real 200/206, revisions, uploads, playback and MP4 in packaged Tauri; test security scope on different workspaces.
2. **P1 authoring parity:** implement `motion asset import`, `motion audio import`, generic semantic `motion edit --json`, and MCP import tools with the same auth/workspace constraints; add CLI↔MCP↔T-Line parity tests.
3. **P1 runtime resilience:** supervisor/queue architecture ADR, fault-injection tests, worker process identity claims, non-destructive stale recovery, bounded retention; keep no-autokill semantics.
4. **P1/P2 exports:** 1080p policy and performance budgets, long media and audio sync tests, font/scene visual parity, persistent streaming/previews.
5. **P2 creator capabilities:** standalone browser studio if in scope, multi-scene/video layer and richer keyframes/easing; UX hardening, accessibility and automated Tauri E2E.
6. **P2 metadata:** repair capability reporting, CLI help/documentation and release status distinctions.

## Release recommendation

**Developer Preview only.** Engine and targeted tests are green; the remaining blockers are cross-application live integration, authoring-surface parity, unattended render resilience, and production media/packaging certification. Do not call this production-ready based on passing focused tests alone.
