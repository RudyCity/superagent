# Studio P6 — Timeline QA and transient occlusion rejection

Date: 2026-10-26
Status: developer preview; conservative detection, not occlusion reconstruction.

## Implemented

- **Independent bounded probes**: `studioTimelineProbeFrames` chooses at most 20 frames beyond the original 5–9 tracking keyframes, distributed along the video and including each gap midpoint. A near-tail check leaves a ~100ms decode margin so low-FPS FFmpeg seeks do not incorrectly fail at the media duration.
- **Identity and topology safety**: for every additional sampled frame, the renderer checks that the number of isolated foreground components has not changed, interpolates expected object position/size/color from the neighboring tracked observations, then uses the existing bounded assignment/gap scoring to verify plausible identities. Transient joins or disappearances lead to explicit `MotionValidationError` (HTTP 400) with a frame number and manual-review explanation, not a fake reconstructed Studio project.
- **Actual rendered-image parity**: each independent probe renders the proposed Studio SVG at that frame and checks foreground mask IoU, precision/recall/F1 and RGB differences against the local MP4 frame. A probe with IoU below 0.38 rejects the scene before project creation.
- **API output**: successful multi-vector reconstructions return `timelineValidation: {status:"passed-sampled", checks:[...], minimumForegroundIoU, meanForegroundIoU, minIdentityGap, note}`. The existing `parityReport` (three keyframes, up to two holdouts), `reconstruction-review.png`, `reconstruction-diff.png` and client contracts stay compatible. Nothing reveals local filesystem paths.
- **T-Line**: the Video → Editable Studio Code panel optionally displays an expandable **Timeline QA** table with the measured frame number, IoU, F1 and object identity association gap. Older backends without this optional report still display their previous checks.

## Validation

- Unit tests verify bounded probe selection for clips of 1, 3, 6 and 12 seconds; strictly ascending frames, no reuse of original keyframes, midpoints included and explicit near-tail validation with low-FPS seek margin.
- A synthetic encoded 3-second MP4 contains two distinct shapes which merge **only during frames 17–19** of the 10fps source, between the five existing P5 comparison frames. P6 identifies the transient merge at a supplementary frame, refuses to save a project and returns a clear error.
- Existing moving, scaling, rotating and reversing shapes continue passing reconstruction, direct React JSX, frame quality and source-vs-rendered PNG tests.
- Authenticated multi-video HTTP response and T-Line component tests validate the additional report and its accessibility.

## Explicit limitations

- Detection is **not** occlusion recovery, hidden-object inference, full object re-identification across disappearance, or semantic segmentation; the system refuses uncertain tracks.
- Up to 20 *extra sampled frames*, not exhaustive frame-by-frame evaluation. Rapid events between probes may still be missed. Identity matching remains a bounded simple color/bounding-box heuristic.
- Each probe decodes an MP4 frame and renders SVG, so P6 trades additional CPU/latency for increased safety. Queued/cancellable background reconstruction is not part of this change.
- No arbitrary complex-video claims, installed Windows Tauri click-through or production approval. Release installer remains a separate packaging/QA gate.
