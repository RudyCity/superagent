# SuperAgent Studio — Code-to-Video developer preview (2026-10-25)

## Implemented

**Purpose:** Render offline self-contained HTML/CSS/SVG animations or a Studio-authored scene/React wrapper into an H.264 MP4. This is the **Code → Video** direction, distinct from P3 video → editable code.

- Engine `src/core/motion/code/studioBrowserVideoRenderer.ts`: local Chrome/Edge/Chromium through pinned `playwright-core@1.56.1`; browser context offline, all external requests aborted, downloads/permissions/service workers disabled. Captures viewport or native Studio SVG at deterministic seconds/frame, pauses CSS/WebAnimations and seeks them directly. First-party native HTML exposes `window.__studioRenderAt(seconds)` to lock frame timing independent of autoplay and reduced-motion settings.
- FFmpeg receives PNG frames on stdin and produces local H.264/YUV420p MP4. Bounded profile: width 160–1920 even, height 90–1080 even, FPS 1–30, duration 0.25–12s, at most 300 frames, <150MiB resulting MP4. No audio support in this first preview.
- Accepted sources: a workspace-owned Studio project (native HTML, also the exact animation embedded in its exported React wrapper), trusted self-contained local HTML up to 256KiB, or **only Studio-generated React TSX** up to 2MiB, which is parsed for its literal offline HTML. TSX is never compiled or executed server-side. External React/Next apps must be built into a self-contained HTML export; arbitrary TSX/URLs are not accepted.
- CLI: `superagent studio code-to-video PROJECT_ID --width 640 --height 360 --fps 12 --seconds 2 --workspace . --json`. Imported local source: `superagent studio code-to-video --file animation.html --trust-html --width 640 --height 360 --fps 12 --seconds 2 --workspace . --json`. For Studio-generated React use `--file animation.tsx --trust-html`. File paths resolve through an authorized workspace and may not escape it.
- HTTP through existing global auth/workspace guard: `POST /api/studio/code-to-video` accepts exactly one projectId/html/reactTsx and validated numeric profile. External HTML/TSX requires `trustLocalHtml: true`. Response includes an opaque result ID, metadata, **never an absolute local path**. `GET /api/studio/code-videos/:id.mp4` returns the private MP4 from its workspace only. Metadata capability `studioCodeToVideo=offline-chromium-ffmpeg-preview-v1` plus live readiness `localCodeToVideoReady` advertises Chrome+FFmpeg availability.
- T-Line Studio editor: capability-gated **Code → MP4** panel with source selector, file input, explicit local HTML trust confirmation, width/height/FPS/seconds, MP4 preview and authenticated download.

## Verification

- Direct first-party Studio scene and external CSS-keyframe HTML both produced valid H.264 MP4 using the real Chrome + FFmpeg on local Windows.
- CSS animation test examined FFmpeg's `framemd5`: five distinct decoded frames from a 5-frame clip. Prevents treating a static screenshot as a successful animation capture.
- Native generated React TSX was parsed without evaluating TSX and successfully encoded as MP4. Arbitrary unrecognized React TSX rejected.
- API integration: refuses untrusted HTML and forged project IDs, renders project and trusted HTML/Studio React wrappers, downloads MP4 with private/no-store headers. Workspace ownership verified; different workspaces cannot read each other's opaque video IDs.
- T-Line UI and API tests: rendering, blob playback/download, opt-in trust requirement, disabled-state controls, workspace-authenticated endpoints and absence of bearer tokens in URLs.
- Build `bun run build` passed; full Studio/Motion regression **358/358 tests, 69 suites**, T-Line Studio frontend **141/141 tests, 28 suites** passed.

## Limitations and production blockers

- **Developer preview, not approved production or a hostile-HTML sandbox.** Authenticated local HTML must come from a trusted source. Chromium isolation and offline policies are defense-in-depth; not a guarantee against browser engine exploits.
- No arbitrary URL/web page navigation, online assets, automatic npm install, Node-based React compilation, server-side execution of arbitrary TSX, exported React component imports, iframe media fetching, advanced JS timelines without `__studioRenderAt`, sound capture, audio muxing or GPU/pixel-perfect parity.
- Existing CSS/WAAPI animations are sampled, not all framework animation timelines. Text/fonts, 3D and dynamic content may vary by renderer. No installed Tauri click-through E2E or cross-browser QA. Windows package must be built separately; Chrome/Edge and FFmpeg must be installed locally. Jobs run synchronously in this initial API; cancellation, queues, timeouts across all stages and worker isolation remain follow-ups.

## Follow-up — async queue, cancellation and optional AAC audio

- Added bounded per-process render queue in `src/core/motion/code/studioCodeVideoJobs.ts`: one active renderer, three waiting jobs, job IDs with strict workspace isolation, `queued/running/cancelling/completed/failed/cancelled` state, progress counters, bounded tracked history (30-minute expiration). Aborts are forwarded to Chromium and FFmpeg, with private failed status and no local output paths exposed. On restart, in-memory state is lost; this is not a durable scheduling system.
- Authenticated API: `POST /api/studio/code-to-video/jobs` (202), `GET /api/studio/code-to-video/jobs/:id`, `POST /api/studio/code-to-video/jobs/:id/cancel` (200). Queue full returns 429. The older synchronous `POST /api/studio/code-to-video` remains for compatibility.
- Optional `audioAssetId` for job, sync route and CLI (`--audio-asset AUDIO_ID`). Only previously imported, checksum-validated Studio PCM16 WAV is accepted. The WAV is written to a private temporary file and FFmpeg muxes AAC 128 kbit/s with H.264. Browser audio is NOT captured. The temporary WAV is removed in normal completion/failure/cancellation; abnormal system termination can leave it behind.
- T-Line editor uploads canonical PCM16 WAV to the existing authenticated Studio audio service and sends only the opaque asset ID in the job request. Panel displays frame status and offers Cancel, MP4 preview and download.
- Real verification: FFprobe confirmed H.264 video plus AAC audio streams and no leftover `.temporary.wav`. Tests cover job completion, active and pending cancellation, maximum queue admission, workspace isolation, job status HTTP and private MP4, audio upload and T-Line cancellation. Full Studio/Motion backend regression: 363 tests; T-Line Studio frontend regression: 144 tests. GUI click-through on installed Tauri build remains not verified.
