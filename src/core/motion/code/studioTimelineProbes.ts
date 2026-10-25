/** Bounded supplementary frame probes for Video-to-Code.
 * Include the midpoint of every tracked interval plus uniformly spaced
 * probes; never count original tracking keyframes as independent QA.
 */
export function studioTimelineProbeFrames(
  totalFrames: number,
  trackedFrames: readonly number[],
  maxProbes = 20,
): number[] {
  if (!Number.isSafeInteger(totalFrames) || totalFrames < 30 || totalFrames > 360 ||
      !Number.isSafeInteger(maxProbes) || maxProbes < 8 || maxProbes > 24 ||
      trackedFrames.length < 2 || trackedFrames.length > 9 ||
      trackedFrames.some((frame, index) => !Number.isSafeInteger(frame) ||
        frame < 0 || frame >= totalFrames ||
        (index > 0 && frame <= trackedFrames[index - 1])))
    throw new Error("Invalid bounded Video-to-Code timeline probe input");
  const tracked = new Set(trackedFrames);
  const probes = new Set<number>();
  // Probe near the tail, but leave a 0.1 s decode safety margin for
  // variable/low FPS clips. FFmpeg may return no image at duration - 1/30 s
  // when the real final source frame is timestamped much earlier.
  const safeTail = totalFrames - 4;
  if (!tracked.has(safeTail)) probes.add(safeTail);
  for (let i = 1; i < trackedFrames.length; i++) {
    const prev = trackedFrames[i - 1], next = trackedFrames[i];
    if (next - prev <= 2) continue;
    const middle = Math.round((prev + next) / 2);
    if (!tracked.has(middle)) probes.add(middle);
  }
  // Recheck the full active duration (including the final 4% that the
  // existing tracking samples intentionally leave as a safe end buffer).
  const remaining = Math.max(0, maxProbes - probes.size);
  for (let step = 1; step <= remaining; step++) {
    const at = Math.max(0, Math.min(totalFrames - 1,
      Math.round((totalFrames - 1) * step / (remaining + 1))));
    if (!tracked.has(at)) probes.add(at);
  }
  // If an evenly spaced probe coincides with a tracking keyframe, use a
  // different staggered grid. Probes must still cover the complete timeline.
  for (let step = 0; step < maxProbes * 3 && probes.size < maxProbes; step++) {
    const at = Math.round((totalFrames - 1) * (step + .5) / (maxProbes * 3));
    if (!tracked.has(at)) probes.add(at);
  }
  if (probes.size < 8)
    throw new Error("Insufficient independent Video-to-Code timeline samples");
  return [...probes].sort((a, b) => a - b);
}
