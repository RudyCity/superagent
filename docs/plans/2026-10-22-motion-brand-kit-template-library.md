# Motion Studio P1 — Workspace Brand Kit and Scene Templates

Date: 2026-10-22
Status: Implemented and tested in source code. Packaged Tauri UI smoke not performed.

## Brand Kit

- Authenticated, workspace-scoped GET/POST `/api/motion/brand-kit`.
- Stored under the selected local workspace at `.superagent/motion/brand-kit.json` with file mode 0600 and atomic writes.
- Revisioned compare-and-swap updates. Schema is strictly validated.
- Editable palette (primary, accent, background, text), font allowlist, brand name and optional **validated local** uploaded logo asset ID.
- No remotely hosted assets, executable templates, arbitrary font files, expressions or plugins.

## Curated scene templates

- GET `/api/motion/templates` returns six designs: `product-launch`, `saas-feature`, `social-announcement`, `editorial-story`, `customer-quote`, and `tech-update`.
- `POST /api/motion/projects/:id/templates/preview` compiles without writes.
- `POST /api/motion/projects/:id/templates` applies through a revision-checked project transaction with automatic pre-commit history backup.
- Optional headline/subtitle; rendered text is escaped by the existing SVG engine.
- Brand colors, logo and font drive the compiled composition; the current scene's fps/duration/audio are retained.
- Template Apply intentionally **replaces** current scene layers and baked effect stack, with T-Line Undo and history restore protecting previous state.

## Test coverage

- `tests/motionBrandTemplate.test.ts` covers validated Brand Kit persistence, conflict checks, workspace isolation and compilation of every template.
- `tests/motionTemplateHttp.test.ts` covers GET/POST routes, preview non-persistence, conflict handling and malformed copy.
- All Motion Studio jobs still use the existing rendering pipeline; a separately packaged Tauri smoke test is outstanding.

## Next phases

Prompt-to-storyboard interactive refinement and production GPU shader effects have not been implemented by this P1 increment.
