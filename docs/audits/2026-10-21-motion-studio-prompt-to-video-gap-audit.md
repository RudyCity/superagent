# Motion Studio — Prompt-to-Video Gap Audit

**Date:** 2026-10-21
**Repos audited:** SuperAgent `main` @ `ca1bd725`; T-Line Desktop `main` @ `99343d3`
**Scope:** Source-level audit of the user journey "describe desired motion in natural language -> agent autonomously produces, previews and revises an editable video."
**Status:** Developer preview. Source-level observations are verified against these commits; no packaged Tauri/live authenticated end-to-end exercise was performed during this audit.

## Executive finding

**The dominant gap is agent product integration, NOT a missing low-level encoder.** The current feature is a declarative Motion editor, deterministic image/frame renderer, FFmpeg MP4 pipeline, workspace-scoped HTTP/MCP services, render queue/supervisor and a manual native T-Line editor. A first-class Motion Director, validated storyboarding/semantic plan compiler, model-visible orchestration contract and prompt/revision user interface are not implemented. Existing MCP actions could be invoked by an appropriately connected external agent, or shell commands executed by an agent, but this is not the same as a tested one-prompt, self-verifying workflow in the default SuperAgent chat experience.

The correct product outcome is **Prompt -> Motion Director -> structured editable scene plan -> safe validated compile -> draft preview -> bounded review/repair -> final MP4 -> conversational semantic revision**, with the timeline available as an optional expert editor. Queue/FFmpeg/MCP are internal mechanisms, not things end users should be required to configure.

## Verified implementation baseline

| Implemented | Code evidence | Important qualification |
| --- | --- | --- |
| Workspace-scoped, revisioned Motion project CRUD and declarative edit transactions | `src/core/motion/project/projectStore.ts`, `src/core/motion/schema/types.ts` | Projects are initially seeded with a default one-scene text composition; no natural-language planner |
| Frame evaluation, SVG preview and FFmpeg H264 MP4 | `src/core/motion/timeline/evaluateFrame.ts`, `runtime/frameSvg.ts`, `render/canvasFrames.ts`, `render/ffmpegEncoder.ts` | Basic layers and animation only |
| Image/audio import with immutable workspace hashes | `src/core/motion/assets/motionAssets.ts`, `assets/motionAudio.ts` | Limited safe formats and small asset sizes |
| Project tools exposed by MCP server (14 Motion tools) | `src/core/mcp/tools/motionMcpTools.ts`, `src/core/mcp/superagentMcpServer.ts` | MCP server exposure is different from tools visible to the default in-process agent |
| CLI/slash commands, jobs, status, cancellation, operator recovery | `src/core/commands/motionCliHandler.ts`, `motionCommand.ts`, `motion/jobs/*` | Require explicit project IDs/operations; no brief-to-motion entry |
| Opt-in FIFO supervisor and MP4 artifact storage/diagnostics | `src/core/motion/jobs/motionSupervisor.ts`, `queueRecovery.ts` | Needs a separate explicitly running SuperAgent CLI process; does not resume interrupted encoding |
| Native T-Line manual Motion editor and authenticated backend proxy | `../t-line/frontend/src/components/MotionStudioTab.tsx`, `../t-line/frontend/src/services/motionStudioApi.ts`, `../t-line/backend/src/motionProxy.ts` | No prompt/chat-to-video in Motion Studio; no packaged desktop end-to-end certification |

## Findings by severity

### P0 — Blocks the user's intended product workflow

**MOT-P0-01: Motion Director and prompt-to-storyboard compiler absent.**
Evidence: `src/core/motion/director/` does not exist. No `*motion*director*`, `*motion*prompt*` or `*motion*storyboard*` implementation was located under `src`; `motionService.ts` exports CRUD/edit/preview rather than a brief-processing service. `projectStore.ts:87-112` creates a generic 300-frame text template.
Impact: A prompt like "15-second dark product ad with animated logo and music" cannot autonomously become a well-composed, scene-specific video through a dedicated supported workflow.
Fix: Implement `MotionBrief`, `StoryboardScene`, `MotionPlan`, AI director planner, schema validation and deterministic compiler; a bounded revise/refine loop preserving project ID and revision.

**MOT-P0-02: No first-class model-visible Motion agent tools or automatic routing.**
Evidence: Motion tool definitions are appended in `src/core/mcp/superagentMcpServer.ts`, while the default agent uses `agent.getActiveTools()/getModelVisibleTools()` in `src/core/agent/ContextBuilder.ts` backed by the separate `src/core/tools/index.ts` registry. A source search found no dedicated Motion definitions in the default in-process tool registry, no Motion skill and no Motion-specific user-intent dispatcher.
Impact: The existence of MCP tools does not mean natural-language chat in the default SuperAgent runtime automatically gets the full workflow. General file/shell tools could be used, but this is not a reliable guided product entry.
Fix: Add a deliberately scoped `motion_generate`, `motion_revise`, `motion_inspect` high-level workflow tool (or equivalent coordinator) to agent toolsets; auto-route clear video/motion intent. Keep low-level create/edit/render operations behind the coordinator, with authorization unchanged.

**MOT-P0-03: T-Line Motion editor has no primary brief/revision chat experience.**
Evidence: `../t-line/frontend/src/components/MotionStudioTab.tsx` implements project picker, create/edit, canvas, timeline, image/audio import and Render MP4. Its text usage is layer editing; there is no submit-prompt/agent-result flow, and the frontend Motion API has no generate/revise endpoint.
Impact: End users must learn layers, keyframes, IDs and jobs.
Fix: Default Motion tab view to brief input, generation state, storyboard/preview and follow-up chat. Keep manual timeline in an optional Edit view. Reuse existing workspace authorization and project revisions; do not embed service tokens in the browser.

**MOT-P0-04: Missing durable prompt intent, storyboard decisions and semantic revision linkage.**
Evidence: `src/core/motion/schema/types.ts` and project store persist geometry, layers, audio, revision and basic metadata, not prompt/brief/storyboard approval, per-scene rationale, source-to-layer mappings, conversation-to-revision trace or generation quality assessment. `updateMotionProject` accepts imperative declarative edits, not "faster transition" language.
Impact: Revisions require the agent to reverse-engineer a scene and can accidentally rewrite unrelated design choices.
Fix: Store validated design intent, storyboard, provenance (never secrets), mappings to project/revision, and edit history; implement semantic patch planning scoped to requested changes.

**MOT-P0-05: End-to-end agent autonomy stops at renderer/queue boundaries.**
Evidence: `src/core/motion/jobs/motionSupervisor.ts:163-181` implements an explicit foreground `--watch` and `--once` process. `MOTION_CAPABILITIES.automaticCrashRecovery=false`. T-Line FIFO checkbox only queues a job; UI tells the user a separate SuperAgent supervisor is required. No orchestration drives plan -> render -> wait -> inspect -> revised render -> response as one request.
Impact: Users can see a queued job never finish if the expected supervisor is not running; they are exposed to implementation details.
Fix: For the prompt workflow, manage worker startup via SuperAgent lifecycle/embedded bounded job orchestration with explicit authorization and fail-closed recovery; send normalized progress and artifact results back to the agent/T-Line.

**MOT-P0-06: No visual/semantic QA feedback loop and prompt acceptance tests.**
Evidence: Encoder validates output dimensions, frame count, duration and checksums, but no Director visual reviewer or frame-sampled composition QA loop exists under src/core/motion. Existing tests/motion*.test.ts cover schema, API, permission, rendering and workers, not natural-language prompt -> approved video -> semantic follow-up.
Impact: Technically valid MP4 can still have poor pacing, unreadable text, or omit elements requested by users.
Fix: Check representative frames, caption requirements, scene coverage, asset presence and render correctness. Optionally use vision review if supported, with bounded repair attempts and no unsupported quality claims.

### P1 — Quality, expressiveness, operations

**MOT-P1-07: Motion expressiveness is far below advanced motion design.**
Evidence: src/core/motion/schema/types.ts:7-43 supports only text/rect/image layers, x/y/opacity/rotation animation tracks and linear/step/easeInOut easing. No video clip, mask, path, morph, nested scene, camera, kinetic typography preset, physics or transition schema.
Impact: Complex prompts cannot be faithfully translated into the present engine.
Fix: Declarative title/transitions/effect presets first; then composition v2 with multiple scenes and carefully sandboxed clips. Never execute arbitrary user JavaScript or untrusted SVG.

**MOT-P1-08: Media sourcing is manual and constrained.**
Evidence: src/core/motion/assets/motionAssets.ts ingests PNG/JPEG/WebP <= 1 MiB and 4 megapixels; motionAudio.ts ingests bounded PCM16 WAV with up to 4 tracks. No Motion-local media search/catalog, stock selection, text-to-speech, music selection or license provenance workflow was located.
Impact: Prompt references to product/logo/music are not reliably resolved automatically.
Fix: Authorize and index workspace assets; select user-supplied media first, then optional generation/licensed providers with provenance.

**MOT-P1-09: Preview/export typography and A/V parity are not certified.**
Evidence: runtime/frameSvg.ts renders SVG, while render/canvasFrames.ts uses napi Canvas. Fonts are restricted to a small built-in allowlist and no pinned embedded font manifest is supported. Browser audio preview and encoded AAC use separate paths.
Impact: Text positioning, wrapping, baseline and perceived timing may not match final MP4.
Fix: Shared text layout, pinned font bundles where licensed, cross-platform golden frames, audio synchronization tests.

**MOT-P1-10: Export/preview budget cannot cover all common video requests.**
Evidence: render/ffmpegEncoder.ts:12-25 allows width 160–1920 and up to 1800 frames (60 s at 30 fps). T-Line frontend/src/services/motionStudioApi.ts:175-185 reads the entire preview into a blob and refuses video above 64 MiB.
Impact: Longer/high-bitrate outputs cannot be previewed safely, higher than 1080p exports are not supported.
Fix: Authenticated seek/range streaming, explicit export/download path, performance/cost budgets and longer-video profiles.

**MOT-P1-11: The opt-in supervisor is not unattended crash recovery.**
Evidence: motion/jobs/motionSupervisor.ts uses exclusive .supervisor.lock; a failed owner is not automatically stolen. queueRecovery.ts keeps uncertain dispatch claims.
Impact: A crash can leave queued work requiring operator inspection before it proceeds.
Fix: Durable process identity, safe owner recovery protocol, fault injection and clearly surfaced stop/retry decisions, without trusting reusable PIDs.

**MOT-P1-12: Live/packaged release qualification is open.**
Evidence: Code/tests/builds are available, but no packaged Tauri -> updated SuperAgent -> prompt agent -> MP4 -> semantic revision smoke test has been certified. Current SuperAgent health: HTTP port 7888 online, version 1.14.8; this does not prove running code includes latest commits. Remote Chrome bridge disconnected, which is not required by isolated FFmpeg renderer.
Impact: Tests of separate surfaces do not establish a production-ready integrated desktop experience.
Fix: Authenticated version/capability handshake, actual packaged Windows E2E, runtime failure modes, workspace permission tests.

### P2 — Later product polish

- Editable visual storyboard, brand-kit/template library, aesthetic references.
- Fine-grained semantic AI undo/redo with history and side-by-side compare.
- TTS/captions and music synchronization, asset licensing and credits.
- Optional vetted image/video/stock integrations, safe transitions/effects packs.
- Compute/token budgets and honest failure/quality reporting.

## Recommended delivery order and acceptance gates

### Phase A — Make one prompt create one editable video (P0)

1. Implement validated MotionBrief, MotionStoryboard, MotionPlan and semantic edit contracts under src/core/motion/director/. The model outputs typed, constrained data; the compiler maps approved effects into safe declarative MotionEdit transactions. Do not run arbitrary generated JS, CSS, shell commands or remote asset URLs.
2. Expose high-level motion_generate, motion_revise and motion_inspect operations to the native SuperAgent agent tool registry, plus intent routing for clear motion/video requests in Indonesian and English. Preserve MCP endpoints for external clients and enforce existing workspace/permission gates.
3. Create one orchestrated workflow: brief -> plan -> validate -> create -> apply edits -> render -> await status -> inspect representative frames/audio -> return MP4, project/revision and concrete shortcomings. Limit retries and preserve editable data on failure. End users must not need IDs, JSON, FFmpeg or a manually started FIFO supervisor.
4. Add prompt-and-revision chat to T-Line Motion Studio as the default. Keep timeline as optional expert Edit mode. Use the existing authenticated proxy and one authoritative SuperAgent project/job store.
5. Gate completion on two real prompts (Indonesian and English) producing valid MP4 with requested dimensions, captions, duration and editable project. A follow-up such as "make the transition faster but preserve all text and branding" must create a revision and video without changing unrelated content.

### Phase B — Improve visual quality and media fidelity (P1)

1. Persist storyboard and decision-to-layer mapping. Supply reusable kinetic-typography and transition presets; allow storyboard review without mandatory confirmations at each step.
2. Add workspace asset catalog and optional licensed adapters; improve typography preview/export parity and audio alignment.
3. Test at least 12 briefs across product ad, explainer and social motion (Indonesian and English), checking narrative coverage, legibility, pacing, scene QA and semantic revision isolation. State unsupported effects instead of pretending they were implemented.

### Phase C — Production reliability (P1/P2)

1. Harden supervisor lifecycle and worker ownership with trustworthy process identities and crash fault injection; avoid stealing uncertain claims.
2. Stream larger MP4 outputs with authorized byte ranges, enforce CPU/memory/disk budgets and benchmark long videos before extending limits.
3. Run packaged Tauri cross-surface tests, auth/workspace escape attempts, prompt-injection isolation from reference material, crashes/retry and media lifecycle tests.
4. Keep developer-preview status until packaged video and semantic follow-up pass.

## Explicit recommendation

**Stop prioritizing new scheduler/FIFO features as the main workstream.** Deliver a constrained agent-facing motion_generate pipeline and prompt-first T-Line UX using the existing engine. Manual timeline editing must be optional. After one-prompt success, invest in visual richness and media selection.

## Scope and verification limits

- This audit inspected source, code search, existing tests/docs and runtime health. It did not rerun the entire test suite or test live authenticated compiled Motion endpoints.
- Dedicated Motion Director/prompt pipeline was not located; generic shell tools or an externally configured MCP agent might perform ad-hoc workflows, which are not a supported prompt-to-video product.
- No SuperAgent/T-Line daemon, worker or CLI session was restarted or stopped, and no application code was changed.
