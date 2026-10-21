# SuperAgent Motion Studio — Creative Direction Upgrade

Date: 2026-10-21
Scope: Motion Director generation, schema-safe compilation, and authoring QA.

## Implemented

- **Prompt-controlled art direction**: minimal, editorial, neon, brutalist, selected by the planner. Direct Indonesian or English style requests take priority over a conflicting AI suggestion; unspecified new prompts receive a deliberate editorial fallback.
- **Editable multi-scene graphic systems** using only current Motion v1 primitives: distinct accent/progress bars, chapter counters, restrained atmospheric blocks, asymmetric editorial framing, and geometric brutalist decoration.
- **Responsive composition** in landscape (16:9), square (1:1), and portrait (9:16), with scene-level left/center/right title and subtitle layouts.
- **Additional kinetic typography**: slide-right, drop-in and swing alongside previous slide, tilt, fade and pop entrances.
- **Compatibility**: programmatic legacy plans without artDirection keep their original scene text layer inventory. No change to Motion project schema version, asset security or user-authored JS execution policy.
- **Safety**: model output remains strict allowlisted JSON; unknown art directions, layouts, scripts, external media URLs, and arbitrary effects cannot be compiled.
- **Tests**: tests/motionArtDirection.test.ts covers visual variants, ratios, text constraints, semantic style override, safe SVG escaping, animation tracks and invalid model output.

## Usage

One prompt is sufficient:

```powershell
superagent motion generate --prompt "Buat promo SaaS 9:16 gaya neon futuristik dengan hook tajam dan CTA, 9 detik" --width 640 --json
superagent motion generate --prompt "Elegant minimal animated product announcement for creators, 16:9" --width 640 --json
```

Motion Director selects a style and creates an editable project, then starts a detached render job. Its active model connection and the FFmpeg installation must be operational.

## Not yet supported

This does not add real 3D, arbitrary vector masks, generative video footage, GPU glow/shaders, image synthesis or automated professional creative critique. Neon currently means high-contrast geometric graphic accents, **not** a shader glow. Voice-over still depends on the separately configured Piper binary and voice model. The existing T-Line prompt-first UI and packaged desktop end-to-end qualification remain separate workstreams.

## Next creative milestones

1. Editable visual moodboards and per-brand palettes, with safe font manifests and layout constraints.
2. Scene-timing weights, richer transition masks and camera-like motion when the renderer and preview share verified behavior.
3. Prompt-first native T-Line gallery with storyboard thumbnails and style variations, preserving revision history.
4. Rendered-frame design reviews with contrast, overflow and readability scoring, plus a bounded agent-guided refinement loop.
5. Human-reviewed cross-surface Windows desktop/video-export qualification before marking production-ready.
