# Studio P8 — Rejected-Clip Occlusion Evidence (Phase 1)

Date: 2026-10-26
Status: developer preview. Read-only evidence; **not assisted identity recovery yet**.

## Implemented

- `POST /api/studio/reconstruct/multi/evidence` accepts a previously imported, workspace-authorized `video-[sha256]` identifier and a safe 30-fps timeline frame index (0–359). Uses the same 1–12-second, ≤12-MiB, resolution/dimension restrictions as the experimental bounded video reconstruction. No arbitrary filesystem paths, shell argument injection or external URL sources are permitted.
- Produces a 3-column evidence contact sheet: 12 timeline frames before, the flagged frame, and 12 frames after (near-end positions are bounded for FFmpeg seek safety). Each shows decoded original pixels, local component boxes and component counts. Response `{status:"review-only",frame,dimensions,observations,previewPngBase64,note}` is bounded to a 2-MiB PNG. The source video and extraction temporary directory remain local and are cleaned up.
- The displayed detection numbers represent local components **within each frame**, not stable object identities. A merge such as 2 → 1 → 2 is observable, but no hidden shape or ownership is guessed.
- This API sits behind the same global T-Line workspace authorization path as existing reconstruction endpoints. It makes **no Studio project and no write/approval decision**. P6 rejects and its sampled IoU and identity gates remain untouched; this inspection cannot override them.

## Verification

- A real encoded synthetic MP4 with two non-overlapping objects that temporarily merge is rejected by P6. Evidence for flagged frame 54 returns frames 42 / 54 / 66 and foreground counts 2 / 1 / 2; PNG magic/size validated; no Studio project created.
- HTTP integration test checks invalid video identifier HTTP 400, authorized import-based evidence HTTP 200, valid PNG content and no internal workspace path in JSON; still no project before normal reconstruction.
- T-Line authenticated client verifies video identifier and frame constraints, PNG magic, base64 bounds and preview object URL ownership. UI shows source evidence only when P6 returns a frame-specific rejection. Changing a file, mode or workspace clears stale evidence; URL resources are revoked on replacement/unmount.

## Limitations / next development

This is the **evidence collection and review stage** of P8, not automatic or approved occlusion recovery. No object continuity during hidden segments, semantic re-identification, manual association persistence, SVG gap filling or alternate rendering is implemented. User-confirmed mappings and a strictly isolated candidate preview workflow will require new safety gates, an evidence manifest, and per-frame QA before any rescued Studio project may be created. Tests use synthetic local clips, not heterogeneous real video footage. Installed desktop Tauri click-through and latest NSIS packaging are separate release gates.
