# Motion Studio — Individual Effect Preview Contract

Date: 2026-10-22
Status: Implemented and verified in code; running server reload not performed.

## Why

T-Line provides a full individual-effects browser on top of the existing 224-effect catalog. Users should be able to inspect an effect without mutating their project. Previously only compound presets exposed a read-only preview endpoint.

## Endpoint

`POST /api/motion/projects/:projectId/effects/preview`

JSON: `{baseRevision, effectId, targetLayerId?, params?, startFrame?, durationFrames?}`

- Reuses the authenticated workspace resolution of the Motion API.
- Checks the caller's baseRevision against the project revision. On mismatch responds with HTTP 409; no modifications are written.
- Rejects malformed effect IDs, invalid target layer kinds, unknown params, invalid durations, and out-of-range keyframes under the existing effects engine.
- Compiles via `effectRegistry.applyToProject(current, application)` and returns the full temporary `MotionProject` with its original revision number; does not persist file assets, mutate the saved project, enqueue a render or start an agent.
- The existing `POST /api/motion/projects/:projectId/effects` is unchanged and still uses the canonical revision-checked project write transaction.

## Verification

- `tests/motionEffectsHttp.test.ts`: a preview changes visible tracks but preserves disk-stored composition and revision, enforces revision conflict, rejects unrecognized parameters.
- `bun x vitest run motion --maxWorkers=2`: **160/160 tests** pass.
- `bun run build`: passed.
- Native T-Line preview/browser implementation: see `t-line/docs/plans/2026-10-22-tline-motion-effects-library.md`.

## Limitations

Preview output is intentionally generated in-memory. Actual rendering parity on a restarted live SuperAgent server and packaged Tauri app is not yet certified. Scriptable shaders, 3D effects, and fully editable nondestructive effect stack are not part of the 224-effect catalog.
