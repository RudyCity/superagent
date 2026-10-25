/** Bounded pixel-level video reconstruction measurements.
 * Reference and reconstructed RGBA images must be exact same dimensions.
 * IoU measures foreground masks; RGB errors measure visual-color differences
 * and should never be described as semantic/structural similarity.
 */
export interface StudioFrameParity {
  foregroundIoU: number;
  foregroundPrecision: number;
  foregroundRecall: number;
  foregroundF1: number;
  rgbMeanAbsoluteError: number;
  foregroundRgbMeanAbsoluteError: number;
}
type RGB = readonly [number, number, number];
const distance = (r: number, g: number, b: number, bg: RGB) =>
  Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
const rounded = (value: number) => Number(value.toFixed(4));

export function measureStudioVideoFrameParity(
  reference: Uint8Array | Uint8ClampedArray,
  actual: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  referenceBackground: RGB,
  actualBackground: RGB,
  foregroundThreshold = 58,
): StudioFrameParity {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width * height > 320 * 720 ||
      reference.length !== width * height * 4 || actual.length !== reference.length ||
      !Number.isFinite(foregroundThreshold) || foregroundThreshold < 1 || foregroundThreshold > 255 ||
      [...referenceBackground, ...actualBackground].some(value =>
        !Number.isFinite(value) || value < 0 || value > 255))
    throw new Error("Invalid bounded video parity inputs");
  let intersection = 0, union = 0, referenceArea = 0, actualArea = 0;
  let allDifference = 0, foregroundDifference = 0;
  const pixelCount = width * height;
  for (let i = 0; i < reference.length; i += 4) {
    const source = reference[i + 3] >= 64 &&
      distance(reference[i], reference[i + 1], reference[i + 2], referenceBackground)
        >= foregroundThreshold;
    const output = actual[i + 3] >= 64 &&
      distance(actual[i], actual[i + 1], actual[i + 2], actualBackground)
        >= foregroundThreshold;
    if (source) referenceArea++;
    if (output) actualArea++;
    if (source || output) union++;
    if (source && output) intersection++;
    const error = Math.abs(reference[i] - actual[i]) +
      Math.abs(reference[i + 1] - actual[i + 1]) +
      Math.abs(reference[i + 2] - actual[i + 2]);
    allDifference += error;
    if (source) foregroundDifference += error;
  }
  if (!union || !referenceArea || !actualArea)
    throw new Error("Video parity requires nonempty foreground in both images");
  const precision = intersection / actualArea;
  const recall = intersection / referenceArea;
  return {
    foregroundIoU: rounded(intersection / union),
    foregroundPrecision: rounded(precision),
    foregroundRecall: rounded(recall),
    foregroundF1: rounded(2 * precision * recall / (precision + recall)),
    rgbMeanAbsoluteError: rounded(allDifference / (pixelCount * 3 * 255)),
    foregroundRgbMeanAbsoluteError: rounded(foregroundDifference / (referenceArea * 3 * 255)),
  };
}


/** Render a diagnostic mask-difference image. The colors are semantic classes,
 * not a visual prediction: red = reference-only (missing reconstruction),
 * cyan = output-only (extra pixels), muted grey = overlap and dark = backdrop.
 * Retains bounded preconditions and never encodes the source frame itself.
 */
export function studioForegroundDiffPixels(
  reference: Uint8Array | Uint8ClampedArray,
  actual: Uint8Array | Uint8ClampedArray,
  width: number, height: number,
  referenceBackground: RGB, actualBackground: RGB,
  foregroundThreshold = 58,
): Uint8ClampedArray {
  // One common validator for both reporting and visualization.
  measureStudioVideoFrameParity(reference, actual, width, height,
    referenceBackground, actualBackground, foregroundThreshold);
  const output = new Uint8ClampedArray(width * height * 4);
  for (let i=0; i<reference.length; i+=4) {
    const source = reference[i+3] >= 64 &&
      distance(reference[i], reference[i+1], reference[i+2], referenceBackground) >= foregroundThreshold;
    const rendered = actual[i+3] >= 64 &&
      distance(actual[i], actual[i+1], actual[i+2], actualBackground) >= foregroundThreshold;
    // Red missing, cyan extra, grey overlap, navy both background.
    const rgb = source && rendered ? [148, 153, 168] :
      source ? [245, 69, 79] : rendered ? [41, 215, 225] : [20, 28, 42];
    output[i] = rgb[0]; output[i+1] = rgb[1]; output[i+2] = rgb[2];
    output[i+3] = 255;
  }
  return output;
}
