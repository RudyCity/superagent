# SuperAgent Motion Studio — Codebase-Aligned Implementation Plan

Date: 2026-10-20
Status: SuperAgent and t-line structural audits complete; CLI, MCP, HTTP and desktop interface planning updated; implementation not started.
Repository: D:/backup from pc asus/Documents Development/superagent
Original baseline: SuperAgent main 8b8ef43a; package version 1.14.7.
Follow-up audit (2026-10-20): SuperAgent main 768469e9, t-line main 18c64ca. Recheck HEAD before executing.
Canonical plan: docs/plans/2026-10-20-superagent-motion-studio-implementation-plan.md

## 1. Product outcome

Build a conversational motion-design studio inside the SuperAgent product experience. Users provide a brief, document, data, screenshots, or brand assets; the system produces a storyboard, editable composition, animation preview, and exported video. Both direct editing and chat revisions operate on the same project revision.

The quality target is a professional code-based motion artifact experience: strong typography, intentional choreography, accurate animated data, targeted edits, and reliable export. Quality parity is a benchmark objective, not a claim that the engine already exists.

Required flagship workflows:
- Product launch: 30–60 seconds of branded typography, product framing, screenshots, transitions, and audio.
- Explainer: 4–8 coherent scenes with diagrams, hierarchy, and adequate reading time.
- Data story: source-backed animated charts with accurate labels and targeted data updates.

Initial release covers professional 2D/2.5D motion. Full character rigging, photorealistic footage generation, unrestricted 3D editing, and simultaneous multi-user editing remain later extensions. These scope boundaries do not relax visual quality or editing requirements.

## 2. Audit evidence and limitations

Inspected package.json, tsconfig.json, repository guidance, tool registries/discovery, model configuration entry points, process/job structures, project access routing, MCP policy/dispatch, server authentication/routes, command registration, and the existing personal-agent master reference.

Verified findings:
- This is an ESM TypeScript terminal-based AI coding assistant with React 18/Ink 5, Vercel AI SDK, Execa, and Vitest. It is not a Next.js/NestJS application.
- Build currently runs tsc with src as rootDir and dist as outDir. There is no browser application build in package.json.
- The server uses node:http; handleServerRoute receives workspace/session context and event helpers.
- The full browser extension has chrome-extension/sidepanel.html. The separate t-line desktop project has now been structurally inspected, including its UI, backend bridge, security middleware and Tauri wrapper.
- Agent discovery and MCP exposure are different registration paths.
- ProcessPool.ts intentionally runs file-read jobs only.
- Job/persistence code exists for external delegation, but related files are undergoing concurrent edits.
- New tools require explicit capability mapping: the current getProjectCapabilityForTool fallback is read.
- No root AGENTS.md was found; .agents/AGENTS.md was read. No nested instructions were found under docs/plans in the instruction-file inventory.

The audit is structural, not a full runtime certification. Motion dependencies, encoder availability, hardware performance, browser isolation, t-line API auth and end-to-end Motion integration have not been validated.

Concurrent work observed:
- src/core/tools/cliBridgeJobStore.ts was untracked.
- src/core/tools/cliBridgeDelegateJobs.ts and related cross-process tests became modified during inspection.
- .superagent/ was untracked.
During the 2026-10-20 recheck, concurrent Hermes/delegation changes were staged or modified in README.md, CHANGELOG.md, package.json, the Hermes master reference, cliBridgeJobStore.ts and retention files. The Motion plan itself was untracked; t-line was clean. Do not overwrite, stage or claim unrelated changes as Motion work. Recheck HEAD and relevant interfaces before implementation.

## 2A. Follow-up audit: t-line Desktop (2026-10-20)

Repository: D:/backup from pc asus/Documents Development/t-line at 18c64ca, with a clean worktree during inspection. Reviewed AGENTS.md plus frontend, Express API bridge, WebSocket/SSE bridge and Tauri sources. This is a source audit, not a Motion runtime test.

| Existing subsystem | Verified entrypoint | Required Motion change |
|---|---|---|
| Terminal executable | SuperAgent src/cli.tsx dispatches process.argv; package bin points to dist/cli.js | Add noninteractive superagent motion command separately from interactive /motion |
| Slash commands | SuperAgent src/core/commands/index.ts, registry.ts, commandCatalog.ts | Register /motion and add discoverable help/domain |
| Desktop frontend | t-line/frontend/src/App.tsx, React/Vite | Add a dedicated MotionStudioTab and registered tab renderer |
| Tab model | t-line/frontend/src/hooks/useTerminals.ts TabData union | Add motion type, project ID, revision, persistence, restore, detach and worktree scoping |
| Desktop command menu | t-line/frontend/src/components/SuperAgentCommands.ts | Expose Motion command/open-in-studio action; local suggestions are not automatically synced with SuperAgent |
| Generic browser preview | t-line/frontend/src/components/BrowserTab.tsx | May bootstrap preview, not full editor or secure execution isolation |
| Desktop bridge | t-line/backend/src/superAgentBridge.ts | Retain workspace-aware session startup and SSE; add scoped progress delivery |
| Desktop HTTP | t-line/backend/src/superAgentRoutes.ts, server.ts | Add authenticated Motion JSON proxy and independent media streaming route |
| Native shell | t-line/desktop-tauri/src-tauri/src/lib.rs, tauri.conf.json | Validate WebView2, packaged URLs, focus, resize, media playback and Save As |
| Preview proxy | t-line/backend/src/previewProxy.ts | Do not use its header-stripping general preview proxy as the Motion trust boundary |

P0 security/integration finding: SuperAgent src/core/utils/serverSecurity.ts requires a bearer/header token for /api routes, but inspected t-line REST helpers proxyToSuperAgent and sendSuperAgentRequest did not visibly forward it. Port-ping in the bridge also accepts any HTTP status as readiness. Treat this as a source-level contract mismatch pending an end-to-end authenticated smoke test; do not claim all installed desktop clients are broken. Fix server-side credential forwarding without putting tokens in browser URLs, renderer storage or logs.

P0 media/isolation finding: existing JSON REST helpers do not stream large media/Range responses, and the general t-line preview proxy can strip CSP/frame security headers. Provide a dedicated authenticated and scope-checked media gateway with Range/HEAD, content type, output ownership, backpressure, disconnect cancellation and isolated AI scene playback. Do not stream video frames through the agent chat or embed untrusted code in the privileged desktop origin.

Detailed client contract and implementation map are captured in Sections 8A and 8B below. Runtime feature, encoder and Tauri tests are still pending.

## 3. Integration map: existing code to planned change

| Area | Verified existing location/symbol | Planned extension |
|---|---|---|
| Agent tool contract | src/core/tools/types.ts — Tool.execute(args, cwd, signal) -> Promise<string> | Thin motionTools.ts adapters return compact structured JSON strings |
| Agent registry | src/core/tools/index.ts — allTools, getToolByName, getToolDefinitions | Register Motion tools without eager browser/encoder imports |
| Tier catalogs | src/core/tools/toolsets.ts — masterToolset, superagentToolset, subagentToolsets, withModeAwareDiscoveryTools | Explicit tier matrix; preserve orchestration-only master behavior |
| Progressive discovery | src/core/tools/toolDiscoveryState.ts — ToolDiscoveryState; toolDiscoveryTools.ts; toolRegistryVersion.ts | Motion tools join authorized catalogs; discovery grants no permissions |
| MCP schema/dispatch | src/core/mcp/superagentMcpServer.ts — MCP_TOOL_DEFINITIONS, createSuperagentMcpServer | Add modular motionMcpTools.ts definitions and dispatcher |
| MCP classification | src/core/mcp/mcpToolPolicy.ts — MCP_TOOL_CLASSIFICATION, DISABLED_MCP_TOOLS | Import Motion classifications; retain disabled-tool rules |
| Project selection | src/core/project/projectRouter.ts — resolveProjectTarget, assertPathWithinProject | Resolve once and pass immutable project context to service/jobs |
| Project authority | src/core/project/projectAccessPolicy.ts — getProjectCapabilityForTool, hasProjectAccess | Explicit operation-to-capability mapping before exposure |
| Request workspace | src/core/mcp/tools/workspaceContext.ts — runWithMcpWorkspace | Never use process.chdir or global workspace switching |
| HTTP dispatch | src/serverRoutes.ts — handleServerRoute | Delegate /api/motion to a new modular route handler |
| HTTP boundary | src/server.ts — runServer, resolveWorkspacePath, /api auth gate | Keep API authentication and add explicit preview/static/artifact policy |
| Slash commands | src/core/commands/index.ts, registry.ts; slash-commands.ts — handleSlashCommand | Register motionCommand.ts; extend help/catalog consistently |
| Executable subcommands | src/cli.tsx — process.argv handlers | Add motionCliHandler.ts; support noninteractive automation and JSON/exit codes |
| Desktop HTTP adapter | t-line/backend/src/superAgentRoutes.ts, superAgentBridge.ts | Authenticated metadata proxy plus independent binary streaming gateway |
| Desktop editor | t-line/frontend/src/App.tsx and hooks/useTerminals.ts | Dedicated motion tab, autosave/revisions, restore and native lifecycle |
| Command domains | src/core/commands/commandCatalog.ts — CommandDomain | Add motion domain without coupling it to transport commands |
| Active jobs | src/core/tools/state.ts — backgroundTasks, notifyTasksChanged; mcp/tools/processTools.ts — handleListActive | Scoped Motion job summaries with a dedicated durable source of truth |
| Read workers | src/core/agent/ProcessPool.ts — FileReadProcessJob, readFilesInProcessPool | Leave file-read restriction intact; create independent render workers |
| Delegation jobs | src/core/tools/cliBridgeDelegateJobs.ts and cliBridgeJobStore.ts | Study patterns only; do not depend on untracked interfaces |
| Model resolution | src/core/config/models.ts — getModelInstanceForTier; providers.ts — getTierModelConfig | Reuse configured providers and tier/model selection |
| Runtime settings | src/core/config/jsonConfig.ts via config exports | Motion settings through getSettings/updateSettings; no new provider env vars |
| Storage roots | src/core/config/paths.ts — getRootConfigDir, getWorkspaceId, getPackageRootDir | Namespaced Motion metadata/cache and packaged browser assets |
| Browser integration | src/core/tools/chromeCommon.ts; advancedAutomationTools.ts | Dedicated render browser; existing extension-backed tools are not the renderer |
| Regression patterns | tests/dynamicToolDiscovery.test.ts, agentDiscoveryTierProjection.test.ts, mcpProjectAccessPolicy.test.ts, mcpWorkspaceRouting.test.ts | Extend relevant coverage plus new tests/motion*.test.ts |

Files in the table are existing integration points, not promises to modify every file. Existing oversized server modules should only receive thin delegation hooks. New code modules must stay below the repository's 1,000-line limit.

## 4. Reuse versus new implementation

Reuse:
- Agent reasoning/tool execution, mode/tier separation, provider configuration, and context handling.
- Request-local workspace routing, project guards, MCP authorization/audit, and transport exposure.
- Existing terminal command registry and status surfaces.
- Reviewed process-tree cancellation and event subscription patterns.
- Existing source-document reading as an input adapter, preserving source provenance.

Build:
- Versioned scene graph and edit transactions.
- Deterministic timeline, layout engine, composition compiler, and rendering runtime.
- Browser studio and a separate frontend build.
- Durable render jobs, output validation, revision-bound artifact registry.
- Storyboard/director workflow, semantic edits, and motion-specific visual review.

The general-purpose UI detection/vision helpers do not establish artistic quality. Motion review needs frame sequences, temporal evaluation, factual checks, and a human rubric.

## 5. Proposed module layout

All locations below are proposed additions, not existing code.

| Location | Responsibility |
|---|---|
| src/core/motion/schema/ | Project schema, validation, migration, typed errors |
| src/core/motion/project/ | Revisions, transactions, asset references, persistence |
| src/core/motion/timeline/ | Keyframes, springs, paths, time mapping, nested composition |
| src/core/motion/layout/ | Text measurement, constraints, safe area, ratio variants |
| src/core/motion/runtime/ | Browser-compatible evaluator, render tree, frame readiness |
| src/core/motion/director/ | Brief, storyboard, composition planning, semantic patches |
| src/core/motion/review/ | Technical checks and vision-backed temporal review |
| src/core/motion/jobs/ | Durable manifests, scheduler, attempts, recovery, cancellation |
| src/core/motion/render/ | Browser lifecycle, frame capture, encoder integration |
| src/core/motion/motionService.ts | Shared application service for all adapters |
| src/core/motion/motionRoutes.ts | Authorized HTTP handlers |
| src/core/tools/motionTools.ts | Agent Tool adapters |
| src/core/mcp/tools/motionMcpTools.ts | MCP definitions, classifications, handlers |
| src/core/commands/motionCommand.ts | Interactive /motion entry and job commands |
| src/core/commands/motionCliHandler.ts | Noninteractive superagent motion subcommand implementation |
| motion-studio/ | Separate browser frontend; proposed React DOM/Vite build |
| tests/motion*.test.ts | Unit, service, policy, concurrency and render tests |

Keep schema/evaluator modules browser-compatible: no node:fs, config secrets, or host process imports. Node-only services depend on them, never the reverse. The new frontend requires explicit dependencies and a build script; React/Ink alone is not a browser UI.

Proposed assets output: dist/motion-studio. The existing tsc build remains the server build; add a separate build:motion-studio and package assembly check. Validate packaging paths through getPackageRootDir. Load studio/compiler/browser features on demand to protect startup time.

## 6. Project model and deterministic rendering

MotionProject: stable project ID, owning registered project, schemaVersion, revision, brand kit, compositions, assets, source references.
Composition: size, rational fps, durationFrames, layer tree, tracks, audio, aspect variants.
Layer: stable ID, semantic role, parent, transform, layout constraints, content, mask, effects.
Track: target property, keyframes/procedure, interpolation, timing.
Asset: immutable content hash, type, dimensions/duration, provenance and readiness.
EditTransaction: baseRevision, operations, affected IDs, actor, reason.
RenderManifest: pinned revision, asset/font hashes, engine/browser versions, random seed, profile.

Core contracts:
- validateProject(project) -> diagnostics.
- compileRevision(revision, profile) -> immutable bundle.
- evaluateFrame(bundle, frameIndex) -> evaluated scene.
- renderFrame(frameIndex) -> frameReady and pixels.
- applyEdits(baseRevision, operations) -> new revision and semantic diff.
- startRender(manifest, authorizedContext) -> jobId.

A frame is a pure function of explicit time and pinned inputs. Random values require a seed; timers, wall-clock time, and independent CSS animations cannot drive export state. Springs require analytical evaluation or deterministic cached integration. Text must wait for the correct font and layout before capture.

Preview and export share evaluator/compiler code. Pixel-identical expectations apply only within a pinned environment; cross-platform rendering uses documented visual tolerances.

Structured components cover normal edits. Custom code components use a restricted SDK and declared editable props. Their internal objects are not automatically editable unless they expose IDs/properties. Arbitrary Node code is not allowed as a scene.

## 7. Studio and design capabilities

Studio workspace:
- Chat/brief pane, interactive preview canvas, inspector, layer tree, and timeline.
- Object selection shared with chat via stable IDs.
- Keyframe and curve editing, trim, reorder, markers, snapping, audio waveform.
- Autosave, undo/redo, revision history, side-by-side comparison.
- Brand kits, assets, reusable components, and editable scene templates.
- Landscape, portrait, and square composition variants using layout constraints.

Composition features:
- Typography hierarchy, per-span styling, word/character choreography.
- SVG/vector shapes, path strokes, gradients, masks, clipping, grouping.
- Accurate charts and diagrams with source-data binding.
- Easing, springs, stagger, motion paths, camera-like movement, matched-object transitions.
- Audio trim/gain/fades, narration/music mixing, captions, media frame seeking.

Use the repository's required hallmark design skill before UI implementation. The browser studio is a new surface. The t-line desktop project has now been inspected. A first-class authenticated MotionStudioTab is a required release surface, and a browser-only preview is an interim smoke-test option. The browser extension may later support read-only preview; it is not a release gate.

Browser delivery must not assume an existing /ui application. Proposed /api/motion endpoints carry auth and scope. A static studio shell may contain no private project data; all project/assets/media routes require explicit authorization. Rendered scene previews should use a separate origin and restrictive CSP; never embed generated executable content into the authenticated admin origin.

## 8. Tool and permission contracts

Suggested agent names use motion_*; MCP wrappers use superagent_motion_*. Both call motionService and share input validation.

| Operation | Project capability | MCP class | Behavior |
|---|---|---|---|
| project_inspect / job_status | read | safe | Return only authorized project metadata |
| project_create / project_edit | write | dangerous | Atomic mutation with revision guard |
| preview_generate | execute plus output-write enforcement | dangerous | Background render, not read-only preview retrieval |
| render | execute plus output-write enforcement | dangerous | Return jobId promptly |
| job_cancel | execute | dangerous | Verify ownership/scope before stopping owned children |
| project_export | write; execute if running encoder/code | dangerous | Create portable artifact with bounded asset collection |
| artifact_read | read | safe | Retrieve previously generated output through scoped access |

The current capability helper returns one capability and defaults unknown names to read. Explicitly map every new name; enforce additional write requirements inside the Motion service or introduce a carefully tested multi-capability helper. Never rely on discovery/classification alone.

Agent tier plan:
- Single mode: authoring, preview, render, inspection, cancellation within its workspace.
- Feature superagent: same operations within its assigned scope.
- Master: planning/delegation and bounded inspection; no direct scene mutation/render execution.
- Specialized subagents: only explicitly allowed operations.
- Extension/t-line: server-side filtering and authority still apply.

MCP registration must update definitions, dispatch, classification, project capability mapping, and direct-call tests together. Progressive agent discovery must preserve ToolDiscoveryState semantics. Do not accidentally expose disabled lifecycle tools.

## 8A. Terminal / agent / MCP / desktop surface parity

Every client must call one canonical motionService, durable MotionJob registry and revisioned project model; no separate t-line data store or render engine.

| Interface | Proposed commands and behavior | Release evidence |
|---|---|---|
| Interactive terminal | /motion new, open, storyboard, preview, render, jobs, cancel, export, doctor | Uses the existing slash registry and authorized current project |
| Scriptable terminal command | superagent motion new, inspect, render, status, cancel, export, doctor | Explicit src/cli.tsx dispatch; JSON output and stable exit codes |
| Agent/MCP | motion_* and superagent_motion_* wrappers | Permission mapping, tool discovery, dangerous opt-in and scope tests |
| HTTP | /api/motion project/revision/job/artifact endpoints | Auth, workspace scoping, versioned data, baseRevision conflicts |
| T-line Desktop | MotionStudioTab with canvas, timeline, inspector, layers, chat, preview and export | Same project ID/revision/artifact as terminal and MCP after refresh |

Command names are planned interfaces, not existing executable features. CLI entry and interactive slash command are distinct registration paths. Implement adapters early enough to validate end-to-end contracts before developing the full timeline. Master-tier multi mode delegates modifications/renders rather than bypassing mutation permissions.

## 8B. T-line integration contract and delivery order

1. SuperAgent first: implement scoped Motion metadata routes, jobs, events, capability negotiation and media access behind the existing src/server.ts API auth gate. Keep src/serverRoutes.ts as thin delegation to src/core/motion/motionRoutes.ts. Server validates owning project/workspace on every operation.
2. Authentication milestone: test t-line/backend/src/superAgentBridge.ts and superAgentRoutes.ts against the real SuperAgent auth gate on port 7888. Preserve both x-workspace-path and workspace query. Add a server-side credential strategy (no browser token leakage), non-2xx propagation and guarded restart semantics.
3. Binary transport: add a dedicated backend/src/motionRoutes.ts or equivalent authenticated streaming module mounted at /api/superagent/motion. Support HEAD, Range/206, ETag, Content-Length, MIME and secure output access. Never route large audio/video frames through the JSON fallback in proxyToSuperAgent.
4. Live jobs: use scoped SSE or durable polling as baseline for projectId/jobId/revision/sequence/stage/progress; reconnect reads persisted job state and never loses completed renders when desktop tabs close. Do not invent WebSocket capability without testing the existing bridge.
5. T-line state: add motion to TabData.type; store stable motionProjectId and revision; add openMotionStudioTab in useTerminals.ts and rendering in App.tsx. Update state sync, tab selection, icons, detach/restore/close lifecycle, keyboard shortcuts and local console command discovery. Keep heavy editor components under frontend/src/components/motion/.
6. Native editor: use the existing React/Vite shell for timeline, inspector, assets, canvas and chat. The AI-generated scene preview runs in an isolated origin/browser context; the generic preview proxy is not trusted. A native WebView is an implementation option only after its isolation, focus, positioning, GPU and cleanup behavior pass.
7. Edit semantics: terminal/MCP and T-line use the same immutable revision IDs, compare-and-swap baseRevision, stable element IDs, undo/redo and conflict feedback. Tab close, app restart or lost websocket does not cancel durable render jobs.
8. Cross-repository versioning: T-line is a separate deployable; test API version negotiation and disabled-feature behavior when one installation is older. Package studio assets in both development and Tauri production builds. Run build/tests for both repositories before release.

Acceptance workflow: create a Motion project in terminal -> open and edit it in t-line -> render via an agent/MCP tool -> inspect/export the same artifact in terminal -> verify revision, permissions and job ownership. Cross-project attempts must be rejected from every surface.

## 9. Durable jobs and storage

Create a MotionJob service separate from ProcessPool and external delegation jobs.

States: queued -> preparing -> rendering -> encoding -> validating -> completed.
Terminal alternatives: failed, cancelled, interrupted. Attempts are recorded separately.

Persist before spawn. Store project scope, owner identity, revision, manifest, timestamps, stage progress, child ownership, logs, output hashes, and validation results. Polling is the recovery baseline; scoped events improve responsiveness.

Proposed data organization:
- Editable project source: an explicit project-relative Motion directory, chosen at creation and guarded by assertPathWithinProject.
- Runtime job metadata/cache: getRootConfigDir()/motion/<workspaceId>/..., with the canonical owner project recorded and verified.
- Session history: remains in existing SQLite transcript storage; store Motion references, not frame payloads.
- Session artifacts: link to Motion project/revision/output; do not repurpose transcript placeholder files.
- File names and write locations are implementation proposals until verified against storage conventions.

Use atomic metadata writes, revision compare-and-swap, and output claims. Do not treat backgroundTasks as a durable Motion database. Mirror summaries into existing status surfaces without maintaining competing authoritative state.

On restart, an unverifiable child is interrupted, not assumed successful. Resume only from validated chunks matching the exact manifest. Cancel checks process ownership and stops only that job tree. Limit concurrency by memory budget; frame streaming uses backpressure. Publish final output atomically after duration/frame/audio validation.

## 10. Browser and execution isolation

Rendering must run without the extension bridge or a user's browser profile. Existing run_headless_browser and control_isolated_cdp tools are extension-backed and unsuitable as the export engine.

Use a dedicated managed browser instance/profile per worker, bounded process execution, network restrictions, and a private asset gateway. Verify the Windows process/isolation mechanism before enabling generated code. Browser sandbox alone does not isolate a privileged Node worker.

Until isolation is proven, allow only verified built-in components and declarative scenes. Generated components cannot read host files, secrets, or arbitrary network locations. Asset intake validates type, size, path boundaries, redirects, and private-network targets.

Keep browser/encoder dependencies lazy. Motion doctor checks availability and reports actionable failures. Heavy installations and startup checks must not run on normal assistant startup. Settings and provider configuration use existing JSON helpers.

Local project rendering is the first supported provider. SSH/chain projects return a clear unsupported-provider result until explicit transfer, remote execution, and authorization contracts exist; no silent local fallback.

## 11. AI direction and visual review

Reuse the existing Agent/model/provider interfaces; avoid a second independent provider stack.

Workflow:
1. Extract source facts, audience, duration, format, and brand.
2. Choose narrative and visual treatment.
3. Produce storyboard and key visual frames.
4. Build composition and choreography.
5. Render low-resolution previews and transition samples.
6. Evaluate content accuracy, layout, reading time, rhythm, and brand.
7. Apply targeted revision patches.
8. Validate and export.

Users can work automatically or stop at storyboard review. Do not add mandatory approval after every scene.

Revisions use baseRevision and stable IDs. A change to one chart value updates its dependent geometry/labels only. If a direct edit races with AI, reject or explicitly rebase a stale transaction. Keep undo and semantic diff visible.

Vision review requires a model with appropriate image capability. Technical checks alone cannot be reported as visual approval. Inspect frame sequences to catch pacing/jitter; isolated keyframes are insufficient. Bound review iterations, token budget, render time, and retries; return the last usable preview with remaining issues when budget expires.

For multi mode, follow the existing master -> feature superagent workflow. Runtime roles may be sequential logical stages; they do not require spawning an agent for every frame or scene.

## 12. Implementation milestones

All implementation work below remains pending. Structural mapping is completed; dependency, sandbox, and benchmark validation remain open.

| Phase | Work | Exit evidence |
|---|---|---|
| 0A: repository alignment | This audit, integration map, concurrency constraints | Paths/symbols and observed limitations recorded |
| 0B: engine feasibility | Pin dependencies, licenses, browser/encoder packaging, Windows isolation, benchmark machine | ADRs and small rendering/isolation proof |
| 0C: desktop transport feasibility | t-line auth contract, streaming/Range artifact proxy, Tauri/WebView2 proof | Authenticated API smoke, 206 media smoke, scoped progress and isolation proof |
| 1: shared foundation | Scene schema, revisions, assets, evaluator, dedicated jobs, terminal executable/slash and minimal MCP/HTTP adapters | 10-second rich-text/vector/image scene supports random seek and MP4 export, usable from both terminal paths |
| 2: professional composition | Constraints, typography, masks, charts, springs, paths, transitions | Three hand-authored flagship scenes meet visual rubric |
| 3: editor + t-line Desktop | Separate frontend build, canvas selection, inspector, timeline, autosave/history, MotionStudioTab and authenticated backend proxy | Desktop direct edits round-trip through shared project model and terminal sees same revision |
| 4: director | Brief/storyboard authoring, semantic revision, visual feedback | All flagship workflows and targeted edit suite |
| 5: media/reliability | Audio/video sync, captions, ratio variants, cancellation/restart, output validation | Durable jobs and media benchmarks pass |
| 6: multi-surface integration/release | Complete agent/MCP/terminal/HTTP/Tauri parity, policy checks, packaging and docs | Both-repository acceptance report and staged rollout |

Build adapters early, then expand capabilities behind a feature flag. New heavy modules stay optional/lazy. Recheck active personal-agent migration work before touching shared files.

Suggested workstream branches for the existing runtime's delegation model:
- motion-foundation: schema, project service, evaluator.
- motion-render: workers, encoding, sandbox, recovery.
- motion-studio: browser editor and frontend packaging.
- motion-director: storyboard, revisions, review.
- motion-integration: tool/MCP/terminal executable/HTTP adapters and acceptance.
- motion-tline: separate t-line repository backend gateway, editor tab, Tauri tests and cross-surface acceptance.
Foundation contracts land first; integration owner coordinates shared registry/server changes. Branch names are proposed; no worktrees or delegated implementation jobs were created by this plan update.

Planning estimate remains provisional: roughly 12–20 weeks for a small experienced team, with major uncertainty until 0B. This is not a deadline commitment or measured delivery estimate.

## 13. Test strategy and release gates

Tests belong under tests/, following repository guidance. Keep source modules below 1,000 lines.

| Test group | Required evidence |
|---|---|
| motionSchema / motionRevision | Invalid IDs/tracks rejected; stale edits conflict; migrations preserve source |
| motionTimeline | Random seek equals ordered evaluation; deterministic spring/seed behavior |
| motionLayout | Fonts, text wrapping, masks, safe areas, ratio adaptation |
| motionJobs | Persist-before-spawn, idempotency, cancel, timeout, restart, scoped output claims |
| motionMcpPolicy | Direct calls and listing enforce read/write/execute and dangerous opt-in |
| motionProjectBoundary | Cross-project job/artifact access rejected; path and symlink escape rejected |
| motionDiscovery | Single/multi catalogs and tier projection; no eager disclosure or permission escalation |
| motionRoutes | Unauthorized media/range requests and workspace spoofing rejected |
| motionPreviewExport | Same revision/time produces matching expected visual output |
| motionIsolation | Generated scene cannot reach host credentials/files or forbidden network |
| motionStudio | Selection/edit/undo/save/reload and keyboard workflow |
| motionMedia | Correct duration/frame count and A/V sync |
| motionTerminal | Interactive /motion and noninteractive superagent motion: JSON output, error exits, workspace and job IDs |
| motionBridgeAuth | Real authenticated t-line -> SuperAgent smoke, token secrecy, workspace header/query and negative status codes |
| motionArtifactTransport | HEAD, 206 Range, media type, bounded streams, cancelled downloads and expired/cross-project access |
| motionTlineState | Native motion tab create/reopen/detach, keyboard, workspace/worktree scope and stale edit conflict |
| motionTauri | Windows WebView2 preview, isolation, packaged assets, playback, save dialog and leak checks |
| motionParityE2E | Terminal create -> t-line edit -> MCP render -> terminal inspect/export same artifact |

Benchmark corpus: 12 fixed briefs, four per flagship workflow, Indonesian/English, fixed assets, landscape/portrait. Separate engine tests using authored scenes from model-dependent prompt-to-video tests.

Release targets:
- Every factual label/number matches input.
- Human average >=4/5 for layout, typography, motion, narrative, and brand; no category below 3.
- All benchmark outputs validate; >=95% success over 100 valid repeated jobs on the reference machine.
- Twenty targeted-edit scenarios preserve unrelated semantic content.
- Audio drift <=1 frame over a 60-second fixture.
- No leaked child processes, unauthorized artifacts, or partially published final files.
- Seek p95 target <250 ms after load, 720p preview target 30 fps, 30-second 1080p30 export target <=5 minutes. These are proposed budgets, not measured results.

Record machine/browser/font versions and tolerances. Do not claim external product parity without a controlled comparison using identical briefs/assets and human evaluation.

## 14. First actionable implementation batch

- [x] Inspect repository guidance and baseline.
- [x] Map registries, routing, command entry, process constraints, and UI/build gap.
- [x] Identify concurrent delegation-job edits and preserve them.
- [x] Audit t-line desktop sources and identify native tab, API, security and streaming gaps.
- [x] Define terminal executable vs interactive slash, MCP, HTTP and Tauri integration contracts.
- [ ] P0: verify and fix t-line authenticated SuperAgent API communication with real smoke tests.
- [ ] P0: prove binary streaming/Range, safe media isolation, and Tauri preview viability.
- [ ] Recheck HEAD and finish dependency/isolation feasibility ADRs.
- [x] Create foundation schema, validation, revision guards, local project service and initial executable adapter.
- [x] Implement deterministic pure frame evaluation and safe declarative SVG preview; validated with foundation tests and a CLI smoke test.
- [ ] Implement font/asset readiness, browser compiler and frame capture.
- [x] Implement isolated persisted foreground MotionJob records, per-project render claims, cooperative cancellation, partial-file cleanup, hash validation and FFprobe verification.
- [x] Add detached local Node rendering worker, persisted immutable source snapshot, exclusive per-project/per-job claims, status and cancellation across CLI process lifetimes.
- [x] Add read-only owner/claim recovery diagnostics that do not kill processes or seize ownership.
- [ ] Add crash-safe ownership reconciliation, bounded scheduler/queue, auto-restart policy and long-render/cross-platform benchmarks.
- [x] Add nine MCP Motion tools with project/workspace routing, read/write/execute mapping, dangerous-tool opt-in and direct-dispatch tests.
- [ ] Add optional agent-facing motion_* wrappers with per-tier discovery and toolset permissions.
- [x] Add interactive /motion registry command and scriptable superagent motion with render/jobs/status/cancel and test coverage.
- [x] Add authenticated SuperAgent HTTP /api/motion metadata, project edit, render/status/cancel, read-only recovery and MP4 GET/HEAD/Range artifact delivery with hash verification.
- [ ] Add scoped Motion SSE events and T-Line backend authenticated/binary streaming proxy.
- [ ] Add MotionStudioTab with stable project/revision IDs and cross-surface parity tests.
- [x] Export a 30-frame declarative scene to FFmpeg H.264 MP4; validate dimensions, frame count, duration and SHA-256; test cancellation and failed encoder.
- [ ] Establish preview/export visual equivalence and 10-second default fixture plus performance benchmarks.
- [ ] Build browser preview from the same runtime.
- [ ] Record benchmark results before expanding to the full editor/director.

Do not mark the studio complete after the first exported video. Release requires all product flows, editing, policy, reliability, and quality gates.

## 15. Documentation, release handling, and current status

This feature plan complements docs/plans/2026-10-18-superagent-hermes-like-implementation-master-reference.md. It does not replace the personal-agent migration reference or alter unrelated phase status.

Before implementing a phase, check repository status and instructions again. Use feature-owned commits and explicit file lists; preserve unrelated changes. Follow repository version/changelog requirements. Run required build/tests before commits and report failures honestly. For actual architecture/MCP/workflow changes, update relevant wiki pages and run wiki:sync/wiki:validate; this document alone does not claim those runtime changes shipped.

Rollout: developer fixtures -> internal use -> opt-in beta -> broader enablement after gates. Feature disablement must preserve saved projects. Schema migrations retain recovery copies.

Current implementation snapshot (2026-10-20): scene schema, revision-checked local project store, deterministic SVG evaluator, FFmpeg/libx264 MP4, detached per-project workers and persisted jobs, interactive /motion and scriptable superagent motion. Nine MCP tools are now registered with classified safe/dangerous exposure and explicit read/write/execute mapping. The global SuperAgent /api authorization gate now delegates /api/motion metadata, revision edits, render/status/cancel/recovery, and MP4 artifact HEAD/GET/Range to a workspace-scoped Motion route. New HTTP and MCP integration tests plus existing regressions passed (54/54 across nine suites), along with a full TypeScript build. This is still a developer preview; automatic crash recovery, job scheduler, audio/assets, browser visual parity, SSE, agent-tier wrappers, T-Line authenticated proxy and native desktop editor remain pending. Phase 0C desktop transport/isolation has not been verified against a live desktop client. Do not claim production readiness.


### 15A. Render feasibility and packaging notes (2026-10-20)

- Verified locally: FFmpeg 8.1 with libx264, ffprobe and installed @napi-rs/canvas. A short preview uses raw RGBA frame streaming (not SVG-to-video shell injection) and validates its output through FFprobe before publication.
- The renderer currently uses @napi-rs/canvas present as a development dependency in package.json; production packaging must make the native canvas dependency available and pin its license/platform support. The package manifest is concurrently modified by Hermes work, so this batch intentionally did not modify package.json or claim packaged functionality.
- Rendering supports foreground and detached local worker processes with on-disk progress and immutable source revision snapshots. CLI status/cancel can be accessed across processes. Detached jobs are not a durable scheduler or safe automatic crash recovery: stale claims and uncertain PID ownership are preserved for manual review. Absent/unknown owners must not be assumed to have exited or be auto-killed.
- Only built-in rect/text layers and a limited resolution/frame budget are supported. The browser preview/editor, audio, custom components, asset intake, MCP exposure and T-Line Desktop remain pending.
- Limit release to developer-preview use until an isolated render worker, font readiness, process lifecycle, permission scope tests and cross-platform packaging pass.

- Verification (detached increment, 2026-10-20): four Motion test suites / 15 tests passed; CLI detached worker spawned after persisted job snapshot, completed H.264 MP4 using a different PID, and reported final artifact metadata. Added fail-closed snapshot hash checks, exclusive execution claims, read-only lock inspection and bounded Windows atomic rename retries when readers briefly hold JSON status files. No root package manifest, Hermes job store, CDP implementation or T-Line files were changed by this increment.

- MCP/HTTP verification (2026-10-20): nine Motion MCP tools wired to existing discovery, dangerous-tool policy, workspace selection, OAuth scope and project access capability guards; HTTP routed under the existing authenticated /api server gate, not an independent unauthenticated listener. HTTP smoke tests verified missing-token 401, forbidden workspace 403, revision conflict 409, completed MP4 200/HEAD, byte-range 206, invalid range 416, and unknown artifact 404. Output hashes are checked with bounded-memory streaming before media responses. Follow-up live T-Line auth and packaged worker execution are unverified.
