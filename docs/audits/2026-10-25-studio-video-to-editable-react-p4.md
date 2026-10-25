# Studio P4 — Video-to-Editable-React JSX follow-up
Date: 2026-10-25
Status: **Developer preview**; available in source. Not a production-ready arbitrary video → React reconstruction.

## Implemented

- New first-party generator: `src/core/motion/code/studioEditableReactExporter.ts` exports a React 18+/Next.js client component with **direct, editable SVG JSX nodes** for every Studio `path`, `rect`, and `text` layer. Unlike the existing compatible React export, this format **does not embed an iframe or use srcDoc**, remote CDNs or raw HTML injection.
- Geometry, colors, path fill/stroke, text content, font family and size are editable directly in the JSX. Animation values and independent x/y, rotation, opacity, scale and stroke-dash tracks are embedded as typed source data. The client component evaluates Studio easing functions and supports local play, pause, replay, timeline scrub and default autoplay/click/hover/scroll triggers. It does not use a global variable/timer framework.
- Request: `GET /api/studio/projects/:id/code.editable.tsx?trigger=autoplay|click|hover|scroll`. The route retains Studio workspace access control, no-store and attachment headers. Existing `code.html` and `code.tsx` are unchanged; no breaking migration.
- CLI: `superagent studio export-code PROJECT_ID --format react-jsx --workspace . --json` saves a unique revision-and-trigger-scoped `.editable.tsx` file in authorized workspace Studio code storage. It does not silently overwrite the previous export.
- T-Line Studio editor: **Export Web Code → Editable React JSX**, visible only if backend capability `studioToCodeFormats` includes `react-jsx`. Other format options remain available.
- Typed React source forbids injection by serializing user text in JS string expressions (no `dangerouslySetInnerHTML`). Only validated Studio scene data is used. Rejects audio, raster/video, nonempty Interaction Graph, unsupported layer kinds and exceeding 96 layers; never hides incompatible content silently.

## Validations

- Backend source `bun run build` passes and TSX generated across all four triggers parses using local esbuild TSX transform.
- Native JSX sample includes independent `<g>`, `<path>`, `<text>` and `<rect>` nodes and keyframe data. Literal markup input is escaped. Legacy sandboxed React wrapper remains byte-equivalent in behavior.
- HTTP route integration verifies authenticated .editable.tsx, expected attachment content, and legacy .tsx unchanged.
- Synthetic MP4 reconstruction (2 tracked shapes on dark background) → fresh editable Studio project → JSX generates two distinct path elements with animation data and compiles with esbuild.
- OCR MP4 → editable text and changing caption timeline → JSX compiles and preserves text/opacity keys.
- CLI `--format react-jsx` executed against an actual workspace project, yielding a compiled `.editable.tsx` file without iframe.
- T-Line frontend API tests check authenticated export, reject malformed iframe output and protect authorization secrets.

## Explicit limitations / next milestones

- This is source reconstruction from **supported bounded Studio vector/OCR tracking**, not semantic recovery of arbitrary React components, CSS grids, DOM hierarchy, arbitrary web apps or complex multi-object videos.
- Images, videos, audio and custom interaction-graph bindings are refused in the direct JSX exporter; the existing native HTML/sandboxed React options remain available for compatible scenes.
- Per-frame visual parity in installed React runtime remains to be measured. Local esbuild verifies TSX syntax and emitted markup, not a complete browser-installed Next.js build or all CSS font/rendering differences. Ongoing P4 should add installed T-Line E2E + true React runtime pixel parity; then improve video segmentation, layering, motion and occlusion with explicit confidence gates.
- No release installer claimed until the new T-Line desktop build is separately compiled and smoke-tested.
