# Motion Studio Effects Engine

Date: 2026-10-22
Implementation: AGY initial implementation; SuperAgent takeover, validation and hardening
Status: Implemented and tested in code; deployment/runtime restart not verified

## Executive Summary

The Motion Studio Effects Engine introduces a declarative, categorized, parameter-validated motion graphics effects architecture to SuperAgent. Operating strictly on safe primitives without arbitrary code execution, external network requests, or unsafe filter strings, the engine registers 224 distinct, tested composition-changing effect variants across 7 creative categories. Effects compile to validated Motion keyframes/layers shared by the SVG preview and Canvas/FFmpeg video renderers. Representative pixel parity and H.264 smoke tests are covered; per-effect pixel-perfect identity across all 224 effects and hardware encoder configurations is not claimed.

## Architecture & Design Principles

### Declarative Representation
Instead of executing imperative JavaScript canvas instructions or running unconstrained shader scripts, every effect is modeled as an immutable `EffectDefinition` implementing:
- `id`: Globally unique, kebab-case identifier (e.g. `entrance-fade-in`, `bg-cyber-scanlines`).
- `name`: Human-readable title for UI and CLI displays.
- `category`: One of seven strict categories (`entrance`, `exit`, `kinetic-typography`, `camera`, `transition`, `background`, `graphic-accent`).
- `description`: Detailed technical explanation of the motion behavior.
- `parameters`: Fully typed dictionary (`number`, `color`, `enum`, `boolean`, `string`) defining default values, allowable bounds (min/max), and enum choices.
- `targetKinds`: Permitted layer targets (`text`, `rect`, `image`, `scene`).
- `apply(context, params)`: Pure deterministic compiler function producing either `tracks` (for animating existing layer properties `x`, `y`, `opacity`, `rotation`) or `newLayers` (for backgrounds, overlays, or graphic accents).

### Security & Isolation
- **No Arbitrary Code**: Effects cannot evaluate strings, access process globals, or invoke arbitrary callbacks.
- **Strict Parameter Sanitization**: Unsupported parameter keys, invalid scalar types, script/markup delimiters in strings, and out-of-range numeric values are rejected. Hex colors require `#RRGGBB`.
- **Engine Invariants Preserved**: Output tracks adhere to engine boundaries (maximum 4 tracks per layer, unique property names, valid keyframe sequences). Effect keyframes are normalized to short scene windows, and extra tracks are never silently dropped.

## Effect Categories & Catalog Breakdown

The registry contains 224 individually compiled, parameterized effects distributed across 7 categories:

| Category | Count | Focus Areas | Key Parameter Controls |
|---|---|---|---|
| `entrance` | 36 | Smooth fades, slides, pops, drops, tilts, swings, whips, spirals, steps, cascades, glissandos, vortexes | `durationFrames`, `offset`, `easing`, `withFade`, `overshoot`, `angle` |
| `exit` | 30 | Directional slides, fades, sinks, floats, spins, tilts, whips, diagonals, drifts, spirals, stutters, pendulums | `durationFrames`, `offset`, `easing`, `rotations` |
| `kinetic-typography` | 35 | Pulse impacts, heartbeats, tremors, earthquakes, swings, rhythm hops, nods, shakes, waves, breathing, glitches, wobbles, seesaws, typewriter punches, sways, elastic snaps | `intensity`, `cycleFrames`, `frequency`, `decay`, `holdFrames` |
| `camera` | 30 | Cinematic pans, pedestals, push-ins, pull-outs, dutch angles, whip pans, handheld drifts, cranes, trucks, crash zooms, trackings, tilt reveals, orbits, vertigos | `distance`, `scale`, `angle`, `easing`, `noise`, `shakiness` |
| `transition` | 26 | Crossfades, hard cuts, white flashes, black dips, accent dips, pushes, wipe bars, curtains, letterboxes, solid wipes, blinds, dissolves, iris transitions | `dipDuration`, `color`, `holdFrames`, `direction`, `barCount` |
| `background` | 32 | Ambient pulses, cyber scanlines, duotone fills, brutalist clusters, neon pillars, crosshairs, radar sweeps, stripes, card backdrops, tickers, blueprints, particle dots, vignettes, hazard stripes, matrix grids | `color`, `secondaryColor`, `lineCount`, `opacity`, `gridSize`, `speed` |
| `graphic-accent` | 35 | Kinetic underlines, highlight boxes, kicker tags, brackets, quotation notches, progress bars, pulse dots, badge backdrops, side pillars, corner pips, double underlines, arrows, callouts, status capsules | `color`, `thickness`, `padding`, `cornerRadius`, `label`, `stepNumber` |

Total effects in registry: **224** (exceeds requirement of >=200).

## Engine Integration Points

1. **Director Service & Planning (`src/core/motion/director/`)**:
   - `directorService.ts`: Augmented `MotionDirectorScene` and `MotionDirectorPlan` schemas with optional `effect?: string` property, validated against `effectRegistry` during AI plan validation.
   - `creativePresets.ts`: `compilePresetComposition()` applies configured effects automatically across individual scenes or global plans during generation.

2. **Capabilities Discovery (`src/core/motion/motionCapabilities.ts`)**:
   - Exposes `effectsEngine: true`, `effectsCount: 224`, and `effectsCatalog: true` to API clients and CLI checks.

3. **HTTP REST API (`src/core/motion/motionRoutes.ts`)**:
   - `GET /api/motion/effects`: Paginated (`offset`, `limit`, default 100, max 100) and filtered (`category`, `q`, `targetKind`, `tag`) catalog search. Returns `filteredTotal` and `hasMore` for pagination.
   - `GET /api/motion/effects/:id`: Inspect individual effect schema and parameters.
   - `POST /api/motion/projects/:id/effects`: Apply an effect to a project using optimistic concurrency and automatic revision tracking.

4. **CLI & Terminal Commands**:
   - `superagent motion effects [--category CATEGORY] [--search QUERY] [--json]`: Lists catalog items.
   - `superagent motion effect-info EFFECT_ID [--json]`: Inspects full parameter definitions.
   - `superagent motion apply-effect PROJECT_ID --base-revision N --effect EFFECT_ID [--layer LAYER_ID] [--params-json JSON]`: Applies an effect to an existing workspace project.
   - In-terminal slash command `/motion effects [category]`, `/motion effect <id>`, and `/motion apply-effect <project-id> <base-rev> <effect-id>`.

5. **Multi-Aspect Ratio & Rendering Parity**:
   - Tested and verified across 16:9 (1920x1080), 1:1 (1080x1080), and 9:16 (1080x1920).
   - Representative 3-frame RGBA/SVG pixel-parity test passes for entrance fade effects; additional parity configurations may show rasterization differences.
   - An actual MP4 render is tested through FFmpeg, with the test conditionally skipped if FFmpeg is not installed.

## Automated Audit and Honest Limitations

- All 224 registered effects compile to 224 distinct, schema-valid full-scene compositions (not just different names).
- All 224 also compile for five short/trailing windows (1, 3, 7, 12, 30 frames): 1,120 individual validations.
- Effects can be searched/applied via CLI and project API; a full drag/drop T-Line effect-stack UI is **not** included.
- The generated-motion AI planner now receives the validated effect ID catalog grouped by category. Unsupported effect IDs are rejected.
- Full Motion regression suite: **26 files, 145 tests passed** (including H.264 export, detached Bun worker, CLI, HTTP catalog endpoints, director, SVG/Canvas parity).
- TypeScript/Bun build: `bun run build` passed. Runtime deployment was not restarted by this work.
- New tests: `tests/motionEffectsCoverage.test.ts`, `tests/motionEffectsHttp.test.ts`; earlier `tests/motionEffectsEngine.test.ts` and `tests/motionEffectsParity.test.ts` remain active.

1. **CPU & Software Canvas Bound**: Rendering currently operates via CPU rasterization with `@napi-rs/canvas` and FFmpeg. Heavy GPU shaders (e.g. WebGL fragment shaders, particle physics simulation engines) are not included.
2. **Layer Track Capacity**: Existing motion schema imposes a hard limit of 4 tracks per layer. Combining multiple complex track-based effects on the same layer requires merging or replacing tracks.
3. **Static Video Inputs**: Effects currently operate on text, rectangle, and image layers. Manipulating video streams within video layers requires frame pre-extraction.
4. **Transaction-Based History**: Effects use compare-and-swap revision updates; a full interactive effect stack and one-click undo UI are not included.

## Staged Follow-Up Roadmap

- **Phase 2 (Compound Multi-Effect Presets)**: Develop preset bundles that chain entrance, kinetic oscillation, and exit effects into single-click macros.
- **Phase 3 (Interactive Real-Time Preview)**: Implement WebGL/WebCodecs playback in Chrome Extension sidepanel for 60fps real-time scrubbing without disk writes.
- **Phase 4 (Audio-Reactive Modulation)**: Connect WAV audio waveform energy/RMS envelopes to effect parameters (e.g. pulsing kinetic typography to music beats).
