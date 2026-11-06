# SuperAgent image compression audit — 2026-11-06

Worker A, shared repo main. No new branch/worktree; no commit, push, restart, lifecycle or live config mutation.

## Implemented
- src/core/media/mediaEngine.ts: Sharp JPEG/WebP/AVIF quality compression (quality 1–100, default 85), optional targetBytes/targetKB (1024-byte KiB) with <=9 bounded serial encodes and truthful targetMet. Lossless optimized PNG with one encoder pass; PNG ignores quality. Report originalSizeBytes, outputSizeBytes, savedBytes, savingsPercent (signed), grewBytes, chosenQuality, targetBytes, attempts, skipped, source preservation. If same-codec recompression enlarges the source, copy its original bytes to the requested new output. Source remains unchanged.
- Security: retain 100 MiB input, 200 MiB output, 40 megapixel decode, signature validation, no-overwrite hard-link publication, staged-file cleanup, workspace scope and path/symlink checks. Reject compression resizing/cropping options to avoid silent ignoring. Warn when JPEG flattens alpha, lossy metadata can be stripped, and targets cannot be met.
- src/core/media/mediaPlanner.ts: compress route, codec restrictions, best-effort warnings, quality target preview, inferred transform mode when operation is supplied, read-only output path/existing-file guards.
- src/core/tools/mediaTools.ts: canonical Agent and generated MCP schema parity for compress and quality/targetKB/targetBytes, unchanged write authorization.

## Evidence
- Scoped command: bun --bun x vitest run tests/mediaCompressQuality.test.ts tests/mediaEngine.test.ts tests/mediaPlanner.test.ts
- New isolated tests cover feasible/impossible targets, PNG pixel parity, JPEG no-growth copying, alpha and JPEG flattening, real AVIF encoding when supported, forbidden options/formats, source unchanged, path traversal, symlink escape, output overwrite, planner honesty, and MCP dispatcher write control/schema.
- Typecheck: bun --bun x tsc --noEmit.
- Diff check: git diff --check on three owned source files.

## Caveats
- Targets are best effort; the bounded quality search and lossy encoder cannot promise arbitrary file sizes. PNG quality/target never makes the codec lossy. Format conversion can increase size.
- Encoder availability is dependent on installed Sharp/libvips; a Sharp package presence does not guarantee all codecs. Sharp has no independent per-encode wall clock deadline here; abort is checked between passes.
- No live MCP server restart, deployment or schema hot-reload performed. Tests prove source and dispatcher parity, not current live MCP serving updated schema.
