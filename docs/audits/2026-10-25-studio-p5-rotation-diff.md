# Studio Video-to-Code P5 follow-up: bounded rotation and mask-diff heatmap

Date: 2026-10-25
Status: developer preview — source/UI implementation; no Windows installer or arbitrary-video claims.

## Implemented: bounded orientation

The existing multi-object prototype still accepts 2–4 isolated high-contrast colored shapes against a stable background, within 1–12 seconds and bounded frames, shapes and file sizes. Connected-component extraction now accumulates second-order binary-mask moments and finds the principal axis of elongated shapes. `studioBoundedRotationSamples` only emits a rotation track when the first mask is sufficiently horizontal/elongated (width-to-height >= 2.2 and principal-axis ratio >= 2), later masks remain anisotropic, initial orientation <= 8°, each consecutive movement <= 16°, and overall displacement <= 32°. Short noise below 3° is ignored. Squares, circles, occluded/merged shapes and discontinuous identity changes do not get a guessed rotation track.

For eligible shapes, x/y follows the mask centroid and scaleX/scaleY follows the eigenvalue ratios of the principal axes. Keyframes remain native Studio `MotionTrack` values and are exported to editable direct React JSX. The exporter also now rotates/scales all SVG elements about their actual layer center, matching the native Studio SVG transform instead of incorrectly rotating local geometry around (0,0). A real encoded test video rotates an elongated rectangle about 25° next to a stationary square and checks recovered angle, absence of invented square rotation, native rendered mask fidelity, and TSX compilation.

This is axis-aligned shape capture plus bounded principal-axis rotation, **not** full optical flow, 3D, a true affine/deformable silhouette model or generic rotation recognition. Existing sampled/holdout IoU >= 0.38 checks still reject poor scenes without saving a fabricated reconstructed project.

## Implemented: source-vs-rendered visual diff

The parity engine adds a bounded, deterministic mask difference image. Diagnostic colors: **red** = reference-only (missing predicted foreground), **cyan** = SVG-only (extra foreground), **grey** = mask overlap, **dark navy** = mutual background. It renders for the same three keyframe times used in the existing side-by-side source/reconstruction contact preview; the two unsampled holdout checks remain in the numeric `parityReport`. Difference pixels are classes, not an AI explanation or a comprehensive all-frame comparison.

A generated `-multi-diff.png` is stored privately per workspace, project and revision with a 2-MiB limit; the existing `-multi-review.png` remains unchanged. The authenticated `GET/HEAD /api/studio/projects/:id/reconstruction-diff.png?revision=N` validates project access, revision, file type, symlinks and PNG magic bytes. Neither on-disk PNG path is returned in the reconstruction API response. Old client/server pairs remain supported: T-Line requests the diff optionally and continues showing its previous preview if unavailable.

T-Line Video → Editable Studio Code now has a collapsible mask-difference visualization, accessible color explanation and cleanup of object URLs.

## Validation and limitations

- Native TypeScript build, bounded video tests, HTTP/private PNG tests, pure pixel-diff color classification, rotation discontinuity/symmetry tests and T-Line UI tests run locally against encoded synthetic MP4 footage.
- Full Studio/Motion and frontend regression suites are run before release commits.
- **Not production approved:** no real-traffic visual fidelity benchmarks, none of the occlusion/crossing assumptions are relaxed, no remote fonts/assets, no installed desktop click-through, no Windows installer generated for this change.
- Next: evaluate longer rotation profiles with unwrapped angle constraints and temporal holdout confidence, expand shape matching with explicit occlusion-aware segmentation, and add optional masking/layer correction tools.
