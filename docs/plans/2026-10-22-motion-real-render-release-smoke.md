# Motion Studio — Real Render, HTTP Exports and Release Smoke

Date: 2026-10-22

## Source verification

`bun x vitest run tests/motionReleaseSmoke.test.ts --maxWorkers=1`

This test **requires** a working FFmpeg executable; it does not silently pass when FFmpeg is missing. Everything is created in the OS temporary directory (not in the SuperAgent repository). It exercises one complete supported Motion workflow:

1. Create a workspace-owned Motion project, add word-rise typography and confetti particles through validated declarative scene compilation.
2. Persist the scene using the canonical revision-checked project update.
3. Render a genuine 30-frame, 160px H.264 MP4 via FFmpeg and verify the returned job status, completed frame count, `ftyp` signature, byte length and SHA-256 checksum.
4. Serve the completed MP4 with the authenticated application's Motion HTTP route logic, check `HEAD`, byte ranges and HTTP 416 on invalid ranges.
5. Convert the completed render to real GIF and VP9 WebM through the HTTP API, verify MIME type and binary signatures.
6. Reject unknown output formats and verify simultaneous conversion requests never return HTTP 500: the extra request is either accepted after the first finishes or rejected with documented HTTP 503 while a conversion is active.

## Converter hardening

The existing exporter caps conversion duration at 20s, source size at 80MiB, output size at 16MiB, conversion time at 45s, and total concurrency at 2. It permits only one converter per immutable completed job. A busy converter now returns HTTP **503** rather than an unhelpful HTTP 500.

## Boundaries

This is a programmatic smoke against the actual compositor, FFmpeg, and Motion HTTP handler. It does **not** establish that the installed Tauri WebView2 can log in, navigate, render and download; that requires a separate GUI smoke on an installed application and a configured SuperAgent service. It does not validate third-party vision providers, live Piper voices, long-duration render stress, or parity of installed fonts.

To check bundled Windows resources separately:
`bun scripts/check-motion-release.cjs --json`.
The strict gate intentionally stays blocked until every declared production condition can be proven.
