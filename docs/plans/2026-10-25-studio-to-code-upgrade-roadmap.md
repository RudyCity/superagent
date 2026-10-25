# SuperAgent Studio to Code — roadmap peningkatan P0–P4

**Date:** 2026-10-25

**Status:** PROPOSED / NOT IMPLEMENTED. Planning artifact only.

**Baseline:** SuperAgent `44fd080b` (Studio-to-Code HTML/SVG/GSAP compiler), T-Line `74e3b8e` (export UI), T-Line `48619d8` (1.3.702 installer).

## 1. Product definition

Build a **dual-output authoring system** from one revisioned composition:

```
Prompt / Studio timeline / imported assets / optional reference video
                     |
          Validated canonical Scene IR
                  /        \
           Video Renderer   Code Compiler
            MP4/WebM/GIF    HTML/SVG + JS, React/Next component
                                  |
                        Autoplay / scroll / click / hover
```

Success means editable, accessible, maintainable **website motion**, not a video tag masquerading as code. Never mutate an existing project to export code. Preserve video-rendering and Studio storage behavior, tenant/workspace boundaries, revision guards, and active MCP/tunnel processes.

### Grounded implementation snapshot

- Implemented: authenticated `GET /api/studio/projects/:id/code.html?trigger=...`; `studio export-code`; T-Line "Export Web Code"; inline SVG text/rect/path; GSAP timeline with keyframes; four triggers; basic HTML controls. Chrome autoplay/scroll/click/hover smoke and backend/frontend suites passed in the baseline audit.
- Gaps: image/video/audio layers rejected; no native React/Next output; no self-hosted runtime bundle; no visual interaction graph; no video-to-code reconstruction; no formal scene-to-frame parity suite; no installed-Tauri interactive editor E2E or complete production release gate.
- Current generated HTML loads GSAP 3.15.0 from public jsDelivr at runtime. Its security, network and licensing posture requires attention before broadly shipping generated results.

## 2. Critical licensing decision — P0 hard gate

**Webflow's official Product Terms §9 (checked 2026-10-25):** GSAP is generally free for permitted uses, including many commercial websites, but §9 defines "Prohibited Uses" involving visual, no-code animation-building products that compete with Webflow; use for such purposes requires prior written consent. Studio is a visual authoring tool. Do **not** infer that free commercial website use gives this editor unqualified rights to embed or redistribute GSAP.

Official source: https://webflow.com/legal/product-terms (section 9).

1. Review the actual Studio product use against §9 with counsel/licensor before production distribution of GSAP-powered editor/output workflows; record the determination.
2. Default output runtime should be **owned engine + browser Web Animations API (WAAPI), SVG/Canvas, native browser events**; use a small independent codegen adapter for easing, keyframe interpolation, scroll and click. Do not copy GSAP source to implement it.
3. Keep the existing GSAP codegen behind an explicitly marked **developer-preview/optional adapter**, not a default distribution requirement. Any future GSAP adapter must honor the result of licensing review.
4. Maintain a third-party license manifest and provenance (including fonts/templates/assets), SPDX/notice export, and a release gate for incompatible licenses.
5. Hard-fail unsupported combinations rather than silently flattening to video or dropping content.

**Exit:** legal/runtime decision documented; default exported HTML does not require GSAP or external CDN; dependency/license inventory passes.

## 3. P0 — Correctness, security, and independent runtime

**P0.1 Canonical timeline compiler**
- Introduce `StudioSceneIR` v1, produced by the already validated composition and compiled effect stack. Each layer retains stable IDs, type, dimensions, paint, transform origin, z-order, style, sources, property tracks, and frame duration.
- Separate `SceneToIR`, `IRToSVG`, `IRToNativeAnimation`, `IRToGSAP(optional)`. Keep shared math/easing defined in one tested module rather than duplicating evaluator formulas by hand.
- Explicitly define frame-0 and nonzero-first-keyframe behavior, overlapping property tracks, hold/step values, scale vs scaleX/scaleY precedence, transform composition order, stroke dash offset and origin coordinates.

**P0.2 Safe standalone HTML runtime**
- First-party Web Animations API + deterministic requestAnimationFrame fallback for unsupported easing/spring; browser-native scroll events/IntersectionObserver when appropriate.
- Support autoplay, click, hover, scroll, scrub/replay without leaking host globals. Multiple instances on one page need unique scopes, isolated controllers and `destroy()` cleanup.
- Harden escaped text/JSON, inline SVG path/attribute validation, URL policies, CSP modes, size limits, asset references and abort/unmount. No user-supplied scripts.
- Ensure `prefers-reduced-motion`, keyboard operation, aria labels and focus navigation; responsive sizing.

**P0.3 Visual and behavioral parity gate**
- Build reference fixtures: 16:9/9:16/1:1, rect/path/text, each supported easing/property, font fallback and advanced effect examples.
- Render sample frames via the current Studio frame renderer and via Chromium/Firefox/WebKit web output; measure normalized visual differences and timeline positions. Establish baseline thresholds per feature then raise gating targets (suggestion: >=95% of curated cases meet their approved parity tolerance).
- Automated security tests: hostile text/path/ids, no exfiltration, no invalid HTML, auth/workspace boundary, oversized content, stale revisions, no hidden lost layers.
- Full browser smoke and T-Line regression tests. Never call production-ready until installed-app E2E passes.

**Exit:** first-party standalone HTML works with networking disabled; all advertised layer/property/easing fixtures pass; no silent drops; browser tests and vulnerability audit green.

## 4. P1 — Portable exports for web developers

**P1.1 Export formats**
- `standalone-html`: one HTML, embedded safe SVG and optional inlined small assets, no external CDN.
- `web-bundle`: zip with `index.html`, `assets/`, JS runtime, CSS, source scene.json, SHA256 manifest, licenses.
- `react-tsx`: typed React component with `useRef/useEffect` and controller teardown; props for width/height, trigger, reduced motion, replay, onComplete.
- `nextjs-component`: `"use client"` module; no window/document during SSR, scope to component root, CSS Modules where needed.
- `svg-static`: poster/frame snapshot with sane limitations. Code export never gets mistaken for a pure video render.

**P1.2 Asset support**
- Safe image import by asset ID and constrained MIME; embed or copy local assets with content hashes and relative paths.
- Video/audio in web exports use isolated HTML media elements with explicit loop, trim/sync limitations and accessibility controls; remain unconverted to vector DOM.
- Record font licensing, fallback stack, dimensions, pixel-ratio behavior, all asset hashes and maximum bundle size.

**P1.3 Studio/T-Line UX**
- "Export" panel: formats, interaction trigger, online/offline options, responsive preview, package details, validation issues, expected output size.
- Download and open in external browser using authorized workspace files; do not put bearer tokens in destination URLs.
- Add CLI/API `export-code --format` and format-specific metadata, without breaking current `export-code --trigger` and `code.html` paths.

**Exit:** sample exported Next.js component compiles and hydrates without warnings in a clean fixture; standalone output works offline; all assets accounted for in manifest; no XSS or CSP violations.

## 5. P2 — Visual interactivity and responsive motion

- Add **Interaction Graph** as a separate declarative model: triggers `enterViewport`, `scrollProgress`, `click`, `hover`, `focus`, `pointer`, `timelineEnd`; actions `play`, `pause`, `reverse`, `seek`, `toggleState`, `navigateToAllowedUrl` (opt-in).
- Graph validation: bounded node/edge count, reject cycles without explicit loop guards, schema version, no arbitrary JS execution or unrestricted network.
- Studio UI: graph/state editor, interactive preview at mobile/tablet/desktop widths, scroll container simulation, hit targets and keyboard/focus feedback.
- Named states and transitions for buttons, cards, menus, hero reveals and product highlights; conditional breakpoints and reduced-motion overrides.
- Templates authored and licensed by SuperAgent, with single source of truth between preview, web code, and MP4 where relevant.

**Exit:** create a hero with scroll reveal and a clickable CTA plus keyboard equivalent entirely from Studio UI; no code edits required; test across Chromium/Firefox/WebKit and reduced motion.

## 6. P3 — Video / reference → editable code (research-gated)

Treat uploaded reference video as evidence, not an exact recoverable original source.

1. **Ingest:** explicit user-provided/authorized video and provenance; frame/scene sampling, duration limits, source rights/usage confirmation, private scratch and cleanup, reject unsafe/private source paths.
2. **Analyze:** scene cuts, optical flow, tracks, OCR/text hints, shapes, colors, timing/easing candidates, layers/occlusions; produce a confidence-scored `MotionReconstructionPlan`.
3. **Reconstruct:** vectorize high-confidence geometry; propose editable SVG/text paths/keyframes and human-readable inferred easing; preserve raster/complex effects as assets or explain degradation rather than fabricate geometry.
4. **Review:** side-by-side video and browser-code preview, frame-difference heatmap, edit timeline, uncertainty warnings, approve/reject layers; batch refine deterministically with a bounded model call budget.
5. **Export:** same independent code exporter as P0/P1, manifest containing reconstruction method and fidelity limits, with no hidden claims of 1:1 source recovery.

Acceptance metric is measured per benchmark (scene detection, track accuracy, text legibility, approximate frame similarity, package size, human editability); **do not promise exact video-to-source reconstruction**. Prioritize simple 2D vector motion and typography; set complex 3D, photorealistic scenes, particle-heavy footage and nonlinear footage as best-effort.

**Exit:** curated set of authorized reference clips produces reviewable editable scenes and working code with explicit fidelity scores and disclosed unsupported portions.

## 7. P4 — Performance, production readiness, integration

- Benchmark render/playback against a defined low-end phone, laptop and high-DPI monitor. Target no long main-thread blocks on sampled hero/card projects and stable memory after 100 mount/unmount cycles.
- Lazy-load assets, freeze offscreen motion via visibility events, browser resize cleanup, reduced motion, batching animation updates, avoid unnecessary GPU layer promotion.
- Integration adapters for Laris.click public CMS and Smart Seller (later) with tenant-safe asset URLs, scoped styles/IDs, CSP and responsive behavior; user-controlled publication.
- E2E real Windows T-Line Studio create → edit → preview → code export → open browser → interact → publish sample page → rollback.
- Secure release gates: signed or verifiable artifacts as appropriate, no high/critical advisories, CLI/API compatibility, offline outputs, runtime license checks, full smoke on latest installed Tauri.
- Documentation, editable source examples, stable manifest schema, migration/version compatibility and reproducible builds.

## 8. Proposed delivery sequence

| Stage | Focus | Approximate planning unit | Hard acceptance |
|---|---|---|---|
| P0 | License decision, independent compiler/runtime, parity/security | 1–2 sprints | Offline and licensable HTML, deterministic tests |
| P1 | HTML bundle + React/Next + asset support | 1–2 sprints | Generated example builds and hydrates |
| P2 | Interaction Graph + preview UI | 1–2 sprints | Working scroll/click/keyboard UX from UI |
| P3 | AI reference video to code | 2–4 sprints, research-gated | Benchmark metrics, editable reconstruction |
| P4 | Performance, installer, CMS/tenant E2E | Continuous release track | Production release gates green |

These are order-of-magnitude estimates, not deadlines. Do P0 immediately and P1/P2 before opening video-to-code publicly. Keep GSAP-licensed export gated until written license review.

## 9. Suggested implementation entrypoints

- `src/core/motion/code/studioCodeExporter.ts` → refactor into `sceneIR.ts`, `nativeRuntime.ts`, `svgCompiler.ts`, `codeExportManifest.ts`, optional `gsapAdapter.ts`.
- `src/core/motion/timeline/evaluateFrame.ts` → align easing/transform semantics and snapshot fixtures.
- `src/core/motion/motionRoutes.ts` and `src/core/commands/motionCliHandler.ts` → format options and bounded downloads.
- `frontend/src/services/studioApi.ts` and `frontend/src/components/StudioTab.tsx` → export settings and preview; dedicated Interaction Graph component after P1.
- Regression tests in `tests/studioCodeExport.test.ts`, dedicated native-runtime parity fixtures and T-Line frontend integration tests.

## 10. Scope boundaries and release claims

The current 1.3.702 GSAP adapter is verified for the limited test scenes, **not** verified for every advanced Studio effect or arbitrary imported video. The proposal is not implemented. Existing MP4, detached jobs, storage migration, MCP tunnels, and unrelated concurrent workspace changes must remain unaffected.

**References:** https://webflow.com/legal/product-terms §9 (licensing), https://gsap.com/docs/v3/Plugins/ScrollTrigger/ (ScrollTrigger semantics), https://gsap.com/docs/v3/GSAP/gsap.matchMedia%28%29/ (reduced motion and cleanup), https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API (native animation runtime).
