# Motion Studio P0–P2 — Storyboard Approval and CPU Particle Accents

Date: 2026-10-22
Status: Implemented and source-verified; packaged Tauri smoke pending.

## AI Motion Director 2.0

New endpoints:
- `POST /api/motion/storyboard/plan` — accepts creative brief, calls the configured AI model and validates its 1–3-scene storyboard. Returns a preview composition **without writing project or starting render**.
- `POST /api/motion/storyboard/preview` — recompiles an edited, approved JSON storyboard into a temporary safe scene.
- `POST /api/motion/storyboard/render` — validates the reviewed plan, runs the deterministic quality gate, creates a new project and queues MP4 via existing detached render workers.

The AI planner remains backed by the current provider configuration and supports bounded, catalog-validated layout, motion, effect IDs, pacing, art direction and subtitles. Model availability is required only for the planning step; preview and approved render do not invoke an AI model. Plan approval endpoint intentionally does not attach image, music or voiceover files: those can be added through the existing editor workflow.

T-Line adds per-scene review/edit for headline, subtitle, layout and accent, plus a read-only frame-scrubbable native canvas. Explicit user approval is required to create/render a project.

## Procedural CPU Particle Accents

`POST /api/motion/projects/:id/particles/preview` and `POST .../particles`.

- `confetti`, `sparks`, `snow` effects compiled to 4–36 schema-compliant animated rectangle layers.
- Stable PRNG seed yields identical geometry/keyframes for the same project/options.
- Respects 200-layer maximum, source-checked optimistic revisions and existing effect stack by recompiling its original source before saving.
- Changing an overlay replaces earlier particle layers rather than accumulating unbounded duplicates.
- Uses the existing SVG/canvas and MP4 rendering path: no remote shaders, raw GPU code, sandbox escapes, arbitrary assets or external JS.

## Testing and explicit limits

- Unit tests: planner injection + validation, preview non-persistence, approved project transaction, 3 particle styles, stack preservation and deterministic animation.
- Particle HTTP tests include stale revisions, unsupported style and invalid counts.
- Native editor tests cover model failure, review/edit/repreview/render, particle Preview/Apply/Undo and POST-only authenticated proxy.
- Package-level Tauri graphical smoke, GPU particle shaders, interactive cubic Bézier handles and expanded media generation are NOT certified by this implementation.
