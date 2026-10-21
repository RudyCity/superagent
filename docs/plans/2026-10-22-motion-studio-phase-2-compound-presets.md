# Motion Studio Phase 2 — Compound Effect Presets

Date: 2026-10-22
Status: Implemented in SuperAgent backend, CLI, and slash command; deployed T-Line native UI not verified.

## Goal

Build on the 224 validated effects with one-click, declarative **compound motion recipes**. A compound preset supplies three independent animation phases (entrance, emphasis, exit), plus a graphic accent overlay. Unlike running effects serially through the old `applyToProject` API, the compound compiler combines tracks into a single evaluated curve, so later phases do not silently erase earlier phases.

## Implementation

- `src/core/motion/effects/compoundPresets.ts`: 16 curated ID-based recipes, safe catalog lookup, target-kind validation and deterministic project compiler.
- Supports animated text layers with 12–420-frame windows, adjustable intensity (0.25–2), collision-free accent layers, 4-track schema limit, and up to 1,024 sampled keyframes per track. Original project data is cloned and not modified.
- Blends motion by adding property deltas (X, Y, rotation) to the existing layer track; opacity is multiplied into the current visibility. For editing a subsection, preserves the original track's keyframes before and after that window.
- Bounded `effectRegistry.apply` generates keyframes and accent layers using the existing safe declarative catalog. No dynamically supplied code, shader scripts, untrusted URLs, or package dependencies are introduced.
- `motionService.ts` writes the resulting composition as one compare-and-swap revision, while `projectStore.ts` maintains locking and workspace asset checks.
- `creativePresets.ts` and `directorService.ts` allow `preset` on global storyboard and individual scenes. The AI planner receives the exact list of supported preset IDs and validates all model output. The per-scene preset wins over the global preset.
- T-Line binary/editor is external to the core backend: no claim of an implemented visual layer-stack panel.

## Built-in presets

| ID | Theme |
| --- | --- |
| `cinematic-rise` | Cinematic |
| `neon-impact` | Neon / cyber |
| `editorial-reveal` | Editorial |
| `bold-hero` | Bold marketing |
| `retro-signal` | Retro |
| `quiet-story` | Minimal / calm |
| `futurist-card` | Tech card |
| `social-burst` | Dynamic social |
| `announcement` | Promo headline |
| `soft-breeze` | Lifestyle |
| `tech-launch` | Launch |
| `magazine-flip` | Magazine |
| `bright-alert` | Alert |
| `gentle-lift` | Elegant |
| `live-stream` | Broadcast |
| `festival-pop` | Celebration |

## Discovery and application

The API is behind the existing SuperAgent auth gate, and all mutations require a workspace accepted by the existing motion endpoint.

```http
GET /api/motion/presets
GET /api/motion/presets?q=neon
GET /api/motion/presets/neon-impact
POST /api/motion/projects/motion-<id>/presets
Content-Type: application/json

{"baseRevision":1,"presetId":"neon-impact","targetLayerId":"title","startFrame":0,"durationFrames":90,"intensity":1}
```

For CLI users:

```sh
superagent motion presets --json
superagent motion preset-info neon-impact --json
superagent motion apply-preset motion-<id> --base-revision 1 --preset neon-impact --layer title --duration-frames 90 --intensity 1
```

Inside the interactive SuperAgent terminal:

```text
/motion presets
/motion preset neon-impact
/motion apply-preset motion-<id> 1 neon-impact title
```

From the text prompt, users may request a neon-impact / editorial-reveal compound animation. `MotionDirectorPlan.preset` is available globally or per scene, but the AI must choose a supported ID. Individual raw effect IDs remain available through `effect`.

## Verification and limitations

- The first 16 presets are tested across 16:9, 1:1, and 9:16 video ratios.
- Verified with `bun x vitest run motion --maxWorkers=2`: **29 test files, 158/158 passed**.
- Verified with `bun run build`: **TypeScript/Bun build passed**.
- A dedicated test renders generated compound effects to real SVG and FFmpeg H.264 MP4, checking output bytes and digest.
- Tests validate type-safe project changes, unique layer IDs, all three animated phases, nonzero startFrame, history-preserving track combination, repeated application, malformed inputs, and per-scene storyboard compile.
- Dedicated API, CLI, slash, and director tests cover the same transactional flow.
- No WebGL particle engine, 3D effects, free-form shader language, realtime WebCodecs preview, or native T-Line drag-and-drop timeline exists in this phase.
- Exiting an effect in the middle of a longer composition restores the original animated position immediately after its defined window; deliberate persistent hiding after an exit still requires a separate scene/visibility edit.
- Graphic accent overlays may increase layer count; the shared Motion project validator enforces a maximum of 200.
- A preset is a **baked** track composite, not yet a nondestructive editable stack with per-phase undo; the revision history can be used to restore a previous project version.
- Pixel-perfect parity across all 16 presets and all hardware encoder backends is not asserted.

## Next phase

Add T-Line UI preset browser, preview thumbnails, timeline parameter inspector and safe undo/redo once an accessible T-Line desktop codebase and lifecycle are verified. Follow with WebGPU/WebGL accelerators as optional render enhancements, without breaking deterministic CPU export.
