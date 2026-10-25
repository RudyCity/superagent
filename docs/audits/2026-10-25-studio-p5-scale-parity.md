# SuperAgent Studio P5 — Bounded Scale Tracking and Sampled Visual Parity
Date: 2026-10-25
Status: Developer preview; source implementation and controlled synthetic validation. No production approval.

## P5.1 — Improved object tracking

- The existing content-addressed MP4/WebM → foreground components → editable SVG reconstruction keeps the same bounded limits: 2–4 separated high-contrast shapes, stable solid-color backdrop, 1–12 seconds, up to nine tracked samples with up to two holdout checks, max 12 MiB and 1280×720 source input.
- Independent `scaleX` and `scaleY` keyframe tracks are now reconstructed along with `x` and `y`. The source contour is still traced from its first appearance; later bounding box dimensions are treated as bounded axis-aligned scaling (0.5–2.0× from the original per dimension).
- Native Studio scales paths around their world-space layer center. The new `studioTrackedObjectTransform` corrects translated x/y values by the scale-induced shift, including the tracing margin, to preserve observed object alignment. The actual native SVG renderer is used for fidelity gating before the project is persisted.
- Changes outside the scale bounds, missing/overlapping objects, unstable associations, severe topology changes and occlusion still fail closed; this is NOT optical flow, rotation reconstruction, 3D animation, deformable silhouette tracking or universal semantic segmentation.

## P5.4 — Visual parity reporting

- New deterministic metrics in `src/core/motion/code/studioVideoParityMetrics.ts`: foreground intersection-over-union (IoU), mask precision, recall, F1, normalized RGB mean absolute error for the whole frame, and normalized RGB mean absolute error on the source foreground.
- Every reported metric compares the decoded reference frame against the **rendered native Studio SVG** at the same frame index. P5 returns `parityReport` with the exact frame index, `keyframe` vs `holdout`, and the six metrics. The existing three-item `measuredForegroundIoU` and two-item `interpolationCheckIoU` remain backwards compatible; the existing two-column contact review PNG remains private behind its authenticated route.
- Fail-closed threshold remains minimum foreground IoU 0.38 for checked keyframe and unseen holdout samples, before a project is created. This is not a comprehensive all-frame or pixel-perfect benchmark; visual differences on unchecked frames still require inspection.
- T-Line Video → Editable Studio Code panel has an expandable per-frame comparison table, showing frame, type, IoU, precision, recall, F1 and RGB error. Legacy backends lacking `parityReport` show the previous basic fidelity feedback.

## Evidence and tests

- Real encoded synthetic MP4 containing one moving and growing colored rectangle plus a second static object is reconstructed to editable Studio SVG tracks and native React JSX. Checks that scaleX and scaleY exceed 1.3× and that the 5 keyframe/holdout parity reports pass the expected quality bounds. Existing videos without resizes still pass.
- Pure metric unit tests validate exact parity on identical frames, distinguish extra predicted pixels (precision) from missed reference pixels (recall), and reject missing/invalid masks. Scale transform tests verify pixel-center compensation and extreme scale refusal.
- HTTP route test verifies parityReport is returned without leaking a private local review PNG path. T-Line panel tests cover the expandable metrics report with explicitly labeled holdout frames.
- Production still blocked on real-video validation, overlapping-object identity, occlusion, rotation, motion vector flow, finer-scale temporal sampling, installed Tauri end-to-end and human-reviewed perceptual fidelity.

## Next technically feasible increments

1. A mask-overlay/difference heatmap beside source/reconstruction contact frames while preserving the current authenticated preview URL contract.
2. Multi-frame shape contour consistency scoring, temporal motion smoothing, and confidence estimates based on the per-object local contour/mask overlap rather than only bounding boxes.
3. Optional GPU/model-assisted semantic segmentation for occlusion and object re-identification, with explicit confidence thresholds and a manual layer assignment fallback.
