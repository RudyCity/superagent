# P3 experimental reference-video → Studio vector reconstruction (2026-10-25)

**Status:** experimental CLI-only prototype, not model-powered, not production-ready.
**Scope:** deliberately constrained high-contrast single moving silhouette, not arbitrary footage.

## Implementation

- `src/core/motion/code/videoReferenceReconstruction.ts` reads only an already imported, SHA-256 verified `video-[sha256]` Studio asset. No arbitrary source path or remote URL.
- Limits: imported data max 12 MiB, 1–12s runtime, 32–1280px source width, 32–720px height, aspect ratio 0.25–4.
- Inspects video with `ffprobe` (10s timeout, 32KiB output limit), extracts three PNG snapshots with `ffmpeg` (15s timeout, max 4MiB per image, 320px sampled width).
- Vectorizes bright foreground on a dark background using existing Studio image tracer. Excludes near-full-frame contours, requires stable bounding-box area ratio.
- Computes x/y positional keyframes for one traced SVG path, saves a **new Studio project** with revisioned composition. Runs full composition validation **before creating** a project. Temporary media is deleted on both success and failure.
- CLI workflow: `studio import-video --file clip.mp4` → `studio reconstruct-video VIDEO_ID` → `studio export-code PROJECT_ID --format html` (or React).
- Capability flag `experimentalVideoVectorReconstruction=single-bright-silhouette-3-frames-cli-only` is descriptive, not a production approval.

## Evidence

- End-to-end synthetic MP4 (30 PNG frames, 160x90, moving white rectangle against black background) imported and reconstructed into a Studio project at revision 2 with one editable SVG path, three position keyframes and HTML export. Reconstruction returned confidence 0.70 (heuristic only).
- Tests `tests/studioVideoReferenceReconstruction.test.ts`: generated-MP4 reconstruction and invalid/missing video-ID rejection **2/2 passed**.
- Full Studio/Motion regression: **331/331 tests, 64 suites passed**.
- `bun run build` passed.

## Explicit limitations and further P3 goals

- This prototype does not use a vision-language AI model and does not perform semantic object segmentation, optical flow, typography/OCR, multi-object tracking, 3D, rotation, camera reconstruction, text extraction, audio or asset bundling.
- The source video and generated SVG **will not** generally match pixel-for-pixel. It infers only one position track from three sample frames; manual review is necessary.
- No T-Line UI for video reconstruction; CLI-only until further authoring, provenance, confidence/quality review, input safety and real-world benchmarking are complete.
- Proposed next steps: confidence-scored multiple-object matching, optical flow, sampled scene-change detection, model-assisted editable semantic layer reconstruction, side-by-side source/output parity, authorized asset provenance and human review, source licensing checks.
- Production launch remains gated on cross-browser verification and installed Tauri end-to-end release checks.
