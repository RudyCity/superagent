# Studio to Code P0 / P1 execution record — 2026-10-25

**Implementation status:** P0 first-party offline vector runtime implemented and tested; P1 sandboxed React/Next.js adapter implemented and tested. Neither constitutes full P0–P4 production approval.

## Delivered
- Default CLI/API export switched from CDN/GSAP to **first-party standalone offline HTML + inline SVG** (`studioToCodeExport: svg-native-html-v2`). Legacy GSAP adapter remains an internal development source but is no longer exposed by the standard CLI/API.
- Native runtime evaluates validated keyframe tracks with Studio easing math and 4 triggers (autoplay, scroll, click, hover); supports pause/replay/scrub, keyboard click activation, reduced-motion fallback and page visibility behavior.
- New `--format react` produces a **React 18+ / Next.js client TSX component**, wrapping the exact offline SVG page inside an isolated sandboxed iframe (`srcDoc`). This is a portable reusable component, *not* direct editable JSX for each vector layer.
- Authenticated routes: `/api/studio/projects/:id/code.html` and `/api/studio/projects/:id/code.tsx` with size caps and attachment responses. CLI `studio export-code PROJECT_ID --format html|react --trigger autoplay|scroll|click|hover`.
- T-Line Studio tab supports format selection when backend advertises the new capabilities, with authenticated downloads and no bearer token in exported files.

## Evidence
- SuperAgent TypeScript build passes.
- Backend Studio/Motion regression: **325 / 325** passed across 62 suites.
- T-Line frontend build passes; Studio regression **125 / 125** across 25 suites.
- Headless Chrome with network disabled: all four HTML animation triggers played with zero JS exceptions or outbound requests; reduced-motion simulation showed end frame (10.0s / 10.0s).
- React TSX generated from real CLI command and TypeScript transpiled with no diagnostics.
- React `srcDoc` integrated into a sandboxed parent iframe in offline Chrome: click trigger advanced animation to 0.8s/10s with no JS exceptions.
- Reproducible browser smoke script added: `python scripts/studio_code_native_browser_smoke.py --json`, which creates and cleans an isolated temp workspace, verifies offline autoplay/scroll/click/hover, sandboxed React and reduced-motion (all pass).
- No installed-Tauri interaction E2E was claimed, and no third-party license approval has been claimed.

## Explicit remaining P0–P4 gaps
- P0 full visual/pixel parity between video renderer and native SVG for all supported effects; Cross Chromium/Firefox/WebKit snapshots, CSS isolation across many components, 100-cycle memory/performance tests.
- P1 **direct per-layer JSX / TSX**, standalone ZIP bundle with manifest and assets, image/video/audio resource packaging, font provenance/CSP manifest and strict ref-count cleanup for all browser lifecycle modes.
- P2 declarative Interaction Graph persisted in scene revisions; breakpoints, hover/click/scroll state machines, UI graph editor and validator.
- P3 automatic reference-video segmentation / optical-flow / AI extraction into editable layers, confidence scoring, review, repair and benchmarking. Current export does *not* reverse engineer existing videos.
- P4 full installed Tauri/WebView2 E2E, low-end device performance tests, cross-tenant CMS publication, release signatures and production gate approvals.

See `docs/plans/2026-10-25-studio-to-code-upgrade-roadmap.md` for acceptance criteria. Keep the legacy media renderer, stored projects, MCP tunnels and unrelated concurrent changes intact.
