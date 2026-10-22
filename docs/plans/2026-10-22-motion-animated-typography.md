# Motion Studio P2 — Animated Typography for Letter and Word Reveals

Date: 2026-10-22
Status: Implemented, revision/HTTP tests passing. Installed Tauri smoke and platform font metrics not certified.

## Supported styles

- `letter-reveal`: sequential reveal of 1–48 Unicode grapheme clusters, preserving emoji/combining marks with Intl.Segmenter.
- `word-rise`: sequential animated opacity and Y-position for up to 48 whitespace-delimited word fragments.
- Typography is compiled to the already supported, safe, deterministic Motion text-layer/keyframe primitives; it requires neither external GPU shader compilation nor executable HTML/CSS.
- Visual spacing is estimated using @napi-rs/canvas font metrics. Font fallback on a different Windows system can change exact glyph positions; frame parity in installed Tauri awaits an actual graphical smoke check.

## Endpoint

`POST /api/motion/projects/:id/typography[/preview]`

Fields: `{baseRevision, targetLayerId, style, startFrame?, durationFrames?}`

- Preview returns the compiled project in-memory and writes nothing.
- Apply uses the same authenticated workspace-scoped CAS project transaction and automatic revision-history backup.
- Existing text layer is replaced with the animated fragments; regular Undo and recovery snapshot can restore it.
- A text layer targeted by existing nondestructive stack entries **cannot be split** until those targeting stack entries are removed, avoiding dangling effect IDs.
- Limits: <=200 total layers; <=48 fragments, valid timeline window, explicit text target, and untrusted input rejection.

## Tests

- `motionTypography.test.ts`: Unicode-safe compiler, deterministic output, valid rendered frame, revisioned save, effect-stack constraints and invalid style/frames.
- `motionTypographyHttp.test.ts`: preview without persistence, apply, 409 stale revision and 400 for bad style.
