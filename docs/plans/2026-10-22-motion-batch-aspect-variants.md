# Motion Studio P2 — Batch Aspect Variants

Date: 2026-10-22
Status: Implemented, TypeScript build and unit/integration tests passed. Real detached FFmpeg batch smoke in installed desktop app not performed.

## Design

- `POST /api/motion/projects/:id/variants` body `{ "baseRevision": 4, "aspectRatios": ["16:9","1:1","9:16"], "width": 640 }`.
- Revision-locked reading of source project; **never mutates it**.
- Maximum three distinct supported aspect ratios and safe even render width 160–1080.
- Uses the existing stack-preserving Smart Resize compiler, creates a separate workspace-owned project for each variant, and commits the resized scene through the canonical project API.
- Queues each project using existing detached Bun render jobs; each job pins a source revision and uses existing MP4/H.264 encoding and artifact validation.
- Checks available queue capacity before creating projects; scheduler rechecks admission atomically on each enqueue.
- Each item reports its aspectRatio, projectId, revision, jobId, jobStatus or error. A failed render does not delete already materialized projects.
- Audio and effect stack are retained by Smart Resize. Output is **queued**; API response does not claim MP4 completion.

## Tests and security

- `tests/motionBatchVariants.test.ts` tests source immutability, three different dimensions, job creation, stale revision, duplicate ratios, queue capacity and partial errors.
- Proxy auth remains the same as Motion Studio. The endpoint is POST-only with server-held auth and workspace allowlist.
- No arbitrary file paths, URLs, shell commands, or unchecked job fanout are accepted.
- Packaged Tauri+live SuperAgent+FFmpeg E2E validation remains outstanding.
