# Studio P3: Local English video OCR to editable TextLayers (2026-10-25)

**Status:** Developer-preview implementation complete at source/test level. This is optional local Tesseract OCR, not general AI video-to-code reconstruction or a production approval.

## Delivered
- Bounded input: an existing workspace-owned, SHA-256-verified Studio `video-<sha256>` media asset; <=12MiB, duration 1–12 seconds, <=1280×720 frame geometry, limited aspect ratio.
- Local `tesseract` 5 compatible executable and installed English `eng` data required on PATH. Not bundled in T-Line. `localStudioTextOcrReady()` checks executable and language data and powers a runtime-ready capability flag `localTextOcrReady`; front-end OCR selection is hidden when unavailable.
- Samples frames near 0%, 48%, 94% with bounded FFmpeg subprocesses, extracts Tesseract TSV with 15-second timeout and 220KiB output limit, parses strict word geometries and per-word confidence >=72, bounded safe ASCII caption text.
- Accepts only one to three English text lines consistently recognized with stable line count/text/bounding-box size, movement and background corner colors across all samples. Failure rejects without creating a misleading project.
- Creates a fresh revisioned Studio composition of true editable `TextLayer` entries with x/y keyframe tracks. Font `Arial`, inferred font size and foreground are approximations; exact glyph layout and color parity aren't promised. Original video is not embedded in web export.
- CLI: `studio reconstruct-video-text VIDEO_ID --workspace . --json`. API: `POST /api/studio/reconstruct/text` behind existing Studio global authentication and workspace authorization. Neither arbitrary filesystem paths nor executable code can be supplied in the request or stored from OCR text.
- T-Line Video-to-Code panel: option `Editable Text (English OCR)` appears if backend advertises `experimentalTextOcrReconstruction=local-english-stable-captions-v1` **and** `localTextOcrReady=true`. Uses existing auth-scoped uploaded video, displays confidence and text, selects newly created project.

## Tests and evidence
- Local Tesseract 5.5 with `eng` available on development Windows machine.
- Generated 30-frame MP4 with moving “STUDIO” caption on light background. Result: one editable text layer at revision 2 with 3 x/y position keyframes, Tesseract estimated confidence 0.963.
- Real CLI import -> reconstruct text -> export HTML, then Chrome with offline network: `#studio-stage text` displays STUDIO; timeline scrub 1.5s / 3.0s; 0 JS exceptions, 0 HTTP requests.
- Unit/integration: TSV bounded/safe parsing, invalid ID rejection, changing-caption no-project test, readiness check, HTTP route invalid ID/valid reconstruction, scene export. **6/6 focused OCR backend tests pass**.
- Frontend OCR UX/auth API tests pass, along with **349/349 backend Studio/Motion tests** across 67 suites and **135/135 frontend Studio tests** across 27 suites.
- TypeScript SuperAgent build and frontend T-Line build pass.

## Still unsupported / not guaranteed
- OCR languages other than `eng`; fine print, poor contrast, rotation/perspective, text appearing/disappearing/changing, transitions, multiple scene cuts, font identification, native video color match, occlusion, multilingual OCR, complete arbitrary footage, model-assisted optical flow, or accurate pixel/perceptual reconstruction.
- T-Line installer must be rebuilt after this change to include new UI/backend routes; installed WebView2 end-to-end interaction, real user videos and production license requirements remain unverified.
- Tesseract must be separately installed on the machine and is not included in distributed app. Do not infer vendor licensing approval from successful tests.

## P3 Caption Timeline follow-up (2026-10-25)

New opt-in command `reconstruct-video-text-timeline` and scoped API
`POST /api/studio/reconstruct/text-timeline`. Strict stable OCR behavior is
unchanged. Nine sequential bounded local FFmpeg/Tesseract frame samples find
up to 3 simultaneous English caption lines and up to 12 segments. Each
caption needs >=2 consecutive high-confidence samples; one-sample ambiguity
is rejected without a project. Empty intervals and text changes produce
separate editable TextLayers, with x/y and step-opacity tracks. Caption
transition boundaries are inferred by rounding between the adjacent samples;
these are **estimates, not frame-accurate segmentation**.

Real MP4 synthetic tests cover STUDIO→HELLO, blank intervals, OCR outliers,
and project absence after a one-off caption fails. Browser test:
`python scripts/studio_ocr_timeline_browser_smoke.py` verifies exported
offline HTML visually updates the layer opacity at 10%, 50%, 90%
(visible STUDIO → empty → visible HELLO), with no network requests and no
JavaScript exceptions. Local Tesseract 5 with `eng` is not bundled.
Real arbitrary footage and installed T-Line OCR end-to-end remain unverified.
