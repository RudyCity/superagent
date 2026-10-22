# Motion Studio — Graph Curves, Offline Beat Sync and Extra Formats

Date: 2026-10-22
Status: Implemented and tested in source. Live packaged Tauri smoke remains outstanding.

## Graph Editor

- T-Line uses the same sampled motion evaluator as the SuperAgent renderer to plot animated property values.
- Selecting an existing keyframe allows revising its numeric value through the normal authenticated revisioned `set-track` edit and Undo/Redo.
- Existing supported easing curves are shown accurately. This is a **sampled value curve editor**, not an arbitrary cubic Bézier handle editor.

## Audio beat sync

- `POST /api/motion/projects/:id/beat-sync/preview` and `POST .../beat-sync`.
- WAV PCM16 audio remains local and hash-validated. A bounded transient detector analyzes energy changes in ~20 ms windows with minimum onset separation.
- Selected text/rect/image layer gets an opacity pulse track based on the detected onsets; preview is read-only. Applying explicitly replaces that layer's existing opacity track and saves a new revision with automatic recovery history.
- This is transient/onset alignment, **not** a tempo grid/BPM extraction, stem separation or DSP-quality beat tracking. Very smooth/silent music may yield zero onsets.

## GIF and WebM

- `GET /api/motion/jobs/:id/exports/gif` and `GET .../exports/webm` convert a completed, checksum-verified MP4 job artifact.
- Short clips up to 20 s; bounded FFmpeg stdout (16 MB), duration, concurrency, and conversion timeout.
- No arbitrary FFmpeg options, paths, user CSS, scriptable shaders, or URLs.
- GIF encodes 10 fps / 480px, WebM 24 fps / 640px in this initial bounded export workflow.
- Larger production exports remain H.264/MP4 via canonical detached render queue.

## Verification

- Graph editor UI and numeric validation tests, audio sync WAV transient tests and real HTTP revision/preview tests.
- Actual FFmpeg transcoding of short generated MP4 into GIF/WebM passed test.
- The running server and packaged Tauri desktop were not restarted or smoke tested.
