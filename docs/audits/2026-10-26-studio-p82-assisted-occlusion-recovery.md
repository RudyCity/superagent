# Video-to-Code P8.2 — Assisted Short-Merge Recovery (Developer Preview)

Date: 2026-10-26
Status: implemented and tested on bounded synthetic MP4; **not approved for general videos or production**.

## Workflow

1. Normal `POST /api/studio/reconstruct/multi` remains **fail-closed** for any detected transient component merger, identity ambiguity, and visual mismatch.
2. Use authenticated `POST /api/studio/reconstruct/multi/evidence` to view before/flagged/after frames and numbered components.
3. User explicitly maps every visible before-object to one unique after-object (two to four total). The server refuses partial, duplicate, excessively different color/size/displacement links, and mismatches with its independently tracked visible identities.
4. Submit `POST /api/studio/reconstruct/multi/recovery` with `{videoId,frame,beforeToAfter,previewOnly:true}`. This runs the full reconstruction in memory, validates the user mappings, limits merge to N→N-1→N, checks existing sampled/holdout quality, and checks the rendered merged-mask overlap during bounded timeline probes. It also runs **extra ±9-frame dense sampling at 3-frame intervals** and rejects prolonged or incompatible merges. A returned `recovery-candidate` contains a local source-versus-render PNG, merged probe indices, foreground IoU and a deterministic 64-character candidate digest. **No Studio project is created by preview.**
5. Only after reviewing the candidate should UI issue `{videoId,frame,beforeToAfter,previewOnly:false,candidateToken,acknowledgement:"APPROVE_MANUAL_RECOVERY"}` to the same authenticated route. The backend **repeats the entire validation** and checks the candidate digest before creating a project. Incorrect mappings, missing approval, stale/wrong tokens and image mismatches are refused without writing a project.
6. The approved project name is **Manual occlusion recovery (inferred motion)**. It retains native editable SVG path/keyframe tracks. Its response includes `recovery.manuallyConfirmed` and `timelineValidation.status="manual-recovery-reviewed"`. A private mode-0600 JSON audit manifest is saved with the project revision in Studio code storage, including the source video identifier, mapping, flagged frame, merged checked frames and measured mask IoU. The HTTP response does not expose filesystem artifact paths.

## Boundaries and safety

- This handles only **small, simple, sampled foreground mergers** between known visible objects, stable background, 2–4 high-contrast separated shapes outside the short merge. A maximum of five QA merger probes are allowed. Color, geometry, displacement, tracking association and mask IoU each have fail-closed thresholds (minimum IoU 0.38).
- **Not true optical occlusion recovery**: the result interpolates tracks across an unobserved interval. The hidden pixels, exact depth, physical motion and appearance are unknown. Human approval indicates acceptance of this approximation, not confirmation of ground truth.
- The candidate digest binds to video ID, selected frame, mapping and sampled quality; it is **not an authentication token**. Existing workspace access control remains the security boundary.
- These are sampled checks, not an every-frame proof. Fast identity swaps, long merges, deformable objects and visually complex backgrounds remain unsupported.
- Preview requires real local imported media; no arbitrary local path, remote URL, network analysis or blanket P6 override is offered.
- Concurrent/replayed approved requests are not yet idempotent. Production should add a single-use operation lease and persistent review history API before release.

## Validation

- A real encoded 3-second synthetic video with a short connected-component merge is rejected by ordinary P6. User mapping + preview succeeds **without any project**; wrong digest refuses commit; correct explicit approval produces exactly one Studio project.
- Contradictory mappings (swapped colors), duplicate indices and implausible displacements/scale are rejected.
- HTTP integration covers workspace-scoped preview, invalid mapping, missing approval, stale digest, valid PNG, privacy and successful approved save.
- A private audit manifest is verified after commit, with no workspace path leakage.
- Full backend Studio/Motion and frontend Studio regressions and build results are recorded separately.

## Remaining work

Installed Windows desktop click-through and packaging, heterogeneous real video accuracy benchmarks, depth/occluder layering, per-frame temporal uncertainty, concurrent approval idempotency and protected review history in the UI remain future release gates.
