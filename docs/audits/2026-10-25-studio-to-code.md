# SuperAgent Studio to Code — implementation and validation (2026-10-25)

## Implemented
- `renderStudioCodeHtml`: deterministic validated composition → editable inline SVG and GSAP timeline source; no MP4/video embed.
- Triggers: autoplay, click, hover, scroll (ScrollTrigger). Scene controls: play/pause, replay and scrub.
- Native layer support: `text`, `rect`, `path`. Keyframes export timing and base properties; easing functions mirror the Studio evaluator. SVG content and inline JSON are escaped to prevent document/script injection.
- Fail closed for unsupported raster/video/audio rather than silently dropping them.
- CLI: `superagent studio export-code PROJECT_ID --trigger scroll --workspace . --json`; revision-scoped file under `.superagent/studio/code/`, no overwrites.
- Authenticated GET API `/api/studio/projects/:id/code.html?trigger=scroll`; `/api/motion` alias remains compatible. Content-disposition attachment, no-cache/nosniff and 4 MB upper bound.
- T-Line Studio editor: trigger selector and **Export Web Code**. Downloads through authenticated fetch, token never placed in external file or URL.

## Test evidence
- SuperAgent `bun run build` passed; backend Studio/Motion suite 318/318 across 62 suites, incl 8 new Studio to Code tests; HTML inline script parsed by JS VM.
- T-Line `bun run build:frontend` passed; frontend Studio suite 124/124 across 25 suites, with two additional authenticated download tests.
- CLI temp workspace `new → export-code --trigger scroll`: generated HTML file, validated SVG and GSAP script tags. Repeating same revision and trigger refuses overwrite.
- Real Chrome (Playwright headless, isolated ephemeral profiles/workspaces): autoplay GSAP loaded and advanced timeline to 3.8s / 10s, no page errors. Click/hover advanced to 1.8s and scroll to 10.0s, with GSAP and ScrollTrigger loaded and no page errors.

## Deployment / current limitations
- Exported HTML loads pinned GSAP v3.15.0 via jsDelivr and requires internet/CDN availability or manual self-hosting of identical scripts. Review official GSAP standard license before redistributing runtime.
- No reference-video frame analysis → recreated code, no raster/image/video/audio conversion, no native React/Next.js component output, no independent browser editor. Audio/video remains supported in existing MP4 renderer.
- Rendering is browser-smooth for the tested scenes but advanced effects and pixel-exact parity between the MP4 renderer and SVG/GSAP are not yet asserted. Future parity and browser matrix tests needed.
- T-Line feature flag only exposes the button when the connected backend advertises `studioToCodeExport=svg-gsap-html-v1`. Existing running MCP/T-Line processes may require a controlled refresh. Full installed Tauri UI E2E requires a new packaged build.
