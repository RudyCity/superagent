# Studio P3 multi-object Video-to-Code — implementation and audit (2026-10-25)

**Delivery:** Experimental 2–4-shape reconstruction in SuperAgent source, authenticated Studio HTTP API, and capability-gated T-Line editor. NOT generalized AI vision and NOT a production release.

## Scope and source ownership
- Input: an already-imported `video-[sha256]` asset from the current authorized local Studio workspace. T-Line may upload MP4/WebM via `POST /api/studio/videos` (base64 request capped at 17MB / binary capped at 12 MiB); no client file paths accepted or rendered back into arbitrary URLs.
- Media inspection uses bounded `ffprobe` and FFmpeg subprocesses with timeouts and bounded capture; 1–12 seconds, max 1280×720 source, 320px sample width, 3 sample times (0%, 50%, 85%), up to 4 foreground components.
- Per-frame 8-neighbour component segmentation of luminance >=155; detects disjoint foreground boxes on stable dark backgrounds; skips noise, fails closed on >4 objects, changed counts, ambiguous/excessive displacement, significant shape-area changes, and unstable backgrounds.
- Small enumerated assignment search (max 4!) matches object identities between samples using normalized position, source color and box area; refuses ambiguous candidates instead of hallucinating object continuity.
- Each tracked object becomes a **separate SVG PathLayer** with x/y keyframes. Preserves sampled object and background colors rather than flattening everything to white.
- Compares each sampled source mask with rendered Studio SVG foreground pixels using **IoU**; refuses each IoU <0.38, creates a 3-row side-by-side PNG (original left / reconstruction right). This is not an arbitrary-frame or perceptual video-quality metric.
- Validates full scene before writing a Studio project. Creates a fresh project at revision 2 (never mutates source video); stores review PNG under `.superagent/studio/code/<projectId>-r2-multi-review.png` (or verified legacy Studio namespace), <=2 MiB.
- CLI: `studio reconstruct-video-multi VIDEO_ID --workspace . --json`. Project output remains exportable with `studio export-code ... --format html|react`.

## Studio authenticated API (behind the global /api auth and workspace gate)
- `POST /api/studio/videos`: upload small imported reference video.
- `POST /api/studio/reconstruct/multi`: require strict content-addressed video ID; reconstruct and return fresh project ID, revision, object list, sample times, IoU array, confidence heuristic, review asset location, limitations.
- `GET|HEAD /api/studio/projects/:id/reconstruction-review.png?revision=N`: validate workspace-owned project, bounded PNG on safe storage path, private no-store and nosniff headers.
- T-Line uses its existing authenticated `motionFetch`, selected workspace, bounded client-side file handling, object URL preview and cleanup; no bearer tokens in exported files, media URLs or query strings.
- Studio tab exposes an opt-in Video-to-Code panel only when `experimentalMultiVectorReconstruction=two-to-four-bright-separated-objects-api-v1`. UI shows source/Studio side-by-side, sample IoU, explicit limitations, and opens the newly created project.

## Evidence
- SuperAgent compile `bun run build` passed.
- Full Studio/Motion regression: **337/337 tests, 66 suites passed**. New tests cover component separation and assignment, two-layer end-to-end MP4, frame property alignment, fidelity PNG, disappearing-object fail closed without creating project, invalid/missing IDs, HTTP upload/route/private image validation.
- T-Line frontend build passed. Full Studio suite **132/132 tests, 27 suites passed**, including authenticated API client tests and 3 interactive panel tests.
- Reproducible developer QA: `python scripts/studio_video_multi_browser_smoke.py --json` generates a synthetic MP4 in a temporary workspace, runs real CLI imports/reconstruction/HTML export, opens the result in offline Chrome and destroys the workspace afterward. Latest rerun: **2 distinct SVG shapes**, timeline scrubbed to 1.5s/3.0s, no network requests or JS errors, sample foreground IoU `[0.9224, 0.9224, 0.9224]`, comparison PNG **640×568** pixels.
- HTTP integration: invalid media rejected, valid upload -> new project -> private PNG GET/HEAD -> revision check passed.

## Not yet implemented or validated
- Arbitrary video understanding, real multi-object instance segmentation under occlusion, semantic object naming, OCR and editable text recovery, optical flow between all frames, camera rotation/3D, event graph inference, footage with changing backgrounds, per-layer direct editable React JSX, audio capture and exact source-code recovery.
- 3-sample IoU is a small binary foreground similarity check, not a guarantee of full-frame color accuracy or animation fidelity.
- Real installed T-Line/WebView2 interactive upload/reconstruction end-to-end, provider/model vision review, extended stability, release signatures and production requirements remain open. This feature stays in developer-preview behind backend capability.
- Global session/tunnel processes and unrelated worktree modifications were not touched.
