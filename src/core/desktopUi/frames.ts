/**
 * frames.ts — Bounded visual-equivalence checks for native desktop captures.
 *
 * Why this exists: byte-for-byte screenshot equality is not a usable freshness
 * signal for live applications (chat streaming, carets, spinners, media). A
 * single animation tick changes the compressed PNG but not the controls a
 * caller is about to click. Input safety therefore relies on:
 *   1. exact OS window identity (pid + native hwnd) and foreground state,
 *   2. accessibility element identity/position fencing (see session.ts),
 *   3. a bounded whole-window pixel budget that still catches gross changes
 *      such as a modal dialog, navigation, or a different document.
 *
 * The comparator fails closed: an undecodable or unsupported PNG is only
 * accepted when the caller-supplied bytes are hash-identical.
 */
import { inflateSync } from "node:zlib";
import { sha256 } from "./png.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_FRAME_PIXELS = 8192 * 8192;
const DECODE_CACHE_LIMIT = 3;

/**
 * Ratio of sampled pixels allowed to differ before a frame counts as changed.
 *
 * Calibration: a streaming chat pane or a large re-render can repaint 5-10% of
 * a window, while a dialog/navigation replaces 25% or more. Element-level
 * fencing in session.ts carries the fine-grained input safety, so this budget
 * only has to catch scene-level swaps. Measurements against a live Electron
 * window showed 5% rejecting legitimate streaming frames.
 */
export const DEFAULT_MAX_FRAME_CHANGE_RATIO = 0.12;
/** Per-channel 8-bit delta that marks one sampled pixel as changed. */
export const DEFAULT_FRAME_CHANNEL_DELTA = 12;
const DEFAULT_SAMPLE_BUDGET = 16_384;

export interface FrameComparisonOptions {
  maxChangedRatio?: number;
  channelDelta?: number;
  sampleBudget?: number;
}

export interface DecodedFrame {
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  pixels: Uint8Array;
}

interface CacheEntry {
  hash: string;
  frame: DecodedFrame | null;
}

const decodeCache: CacheEntry[] = [];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode the PNG subset emitted by OS capture APIs; null when unsupported. */
export function decodePngFrame(bytes: Uint8Array): DecodedFrame | null {
  try {
    const buffer = Buffer.from(bytes);
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = -1;
    let sawHeader = false;
    const idat: Buffer[] = [];

    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > buffer.length) return null;

      if (type === "IHDR") {
        if (length !== 13) return null;
        width = buffer.readUInt32BE(dataStart);
        height = buffer.readUInt32BE(dataStart + 4);
        bitDepth = buffer[dataStart + 8];
        colorType = buffer[dataStart + 9];
        const compression = buffer[dataStart + 10];
        const filterMethod = buffer[dataStart + 11];
        const interlace = buffer[dataStart + 12];
        if (compression !== 0 || filterMethod !== 0 || interlace !== 0) return null;
        sawHeader = true;
      } else if (type === "IDAT") {
        idat.push(buffer.subarray(dataStart, dataEnd));
      } else if (type === "IEND") {
        break;
      }
      offset = dataEnd + 4;
    }

    if (!sawHeader || idat.length === 0 || bitDepth !== 8) return null;
    const channels: DecodedFrame["channels"] | 0 =
      colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
    if (!channels) return null;
    if (width <= 0 || height <= 0 || width * height > MAX_FRAME_PIXELS) return null;

    const stride = width * channels;
    const expectedBytes = height * (stride + 1);
    const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedBytes }) as Buffer;
    if (raw.length < expectedBytes) return null;

    const pixels = new Uint8Array(height * stride);
    let previous = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
      const rowStart = y * (stride + 1);
      const filterType = raw[rowStart];
      const line = raw.subarray(rowStart + 1, rowStart + 1 + stride);
      const out = pixels.subarray(y * stride, (y + 1) * stride);
      for (let i = 0; i < stride; i++) {
        const value = line[i];
        const left = i >= channels ? out[i - channels] : 0;
        const up = previous[i];
        const upLeft = i >= channels ? previous[i - channels] : 0;
        let reconstructed: number;
        switch (filterType) {
          case 0: reconstructed = value; break;
          case 1: reconstructed = value + left; break;
          case 2: reconstructed = value + up; break;
          case 3: reconstructed = value + ((left + up) >> 1); break;
          case 4: reconstructed = value + paeth(left, up, upLeft); break;
          default: return null;
        }
        out[i] = reconstructed & 0xff;
      }
      previous = out;
    }

    return { width, height, channels, pixels };
  } catch {
    return null;
  }
}

function decodeCached(bytes: Uint8Array): DecodedFrame | null {
  const hash = sha256(bytes);
  const hit = decodeCache.find((entry) => entry.hash === hash);
  if (hit) return hit.frame;
  const frame = decodePngFrame(bytes);
  decodeCache.unshift({ hash, frame });
  while (decodeCache.length > DECODE_CACHE_LIMIT) decodeCache.pop();
  return frame;
}

/**
 * Ratio (0..1) of sampled pixels that changed materially.
 * Returns null when either frame cannot be decoded or dimensions differ.
 */
export function frameChangeRatio(
  before: Uint8Array,
  after: Uint8Array,
  options: FrameComparisonOptions = {},
): number | null {
  if (sha256(before) === sha256(after)) return 0;

  const first = decodeCached(before);
  const second = decodeCached(after);
  if (!first || !second) return null;
  if (first.width !== second.width || first.height !== second.height || first.channels !== second.channels) {
    return 1;
  }

  const channelDelta = options.channelDelta ?? DEFAULT_FRAME_CHANNEL_DELTA;
  const sampleBudget = options.sampleBudget ?? DEFAULT_SAMPLE_BUDGET;
  const totalPixels = first.width * first.height;
  const step = Math.max(1, Math.floor(Math.sqrt(totalPixels / Math.max(1, sampleBudget))));
  const comparedChannels = first.channels === 4 ? 3 : first.channels;

  let sampled = 0;
  let changed = 0;
  for (let y = 0; y < first.height; y += step) {
    const rowStart = y * first.width * first.channels;
    for (let x = 0; x < first.width; x += step) {
      const index = rowStart + x * first.channels;
      let differs = false;
      for (let channel = 0; channel < comparedChannels; channel++) {
        if (Math.abs(first.pixels[index + channel] - second.pixels[index + channel]) > channelDelta) {
          differs = true;
          break;
        }
      }
      sampled += 1;
      if (differs) changed += 1;
    }
  }
  if (sampled === 0) return 1;
  return changed / sampled;
}

/** True when the two captures are hash-identical or visually within budget. */
export function framesEquivalent(
  before: Uint8Array,
  after: Uint8Array,
  options: FrameComparisonOptions = {},
): boolean {
  if (sha256(before) === sha256(after)) return true;
  const ratio = frameChangeRatio(before, after, options);
  if (ratio === null) return false;
  return ratio <= (options.maxChangedRatio ?? DEFAULT_MAX_FRAME_CHANGE_RATIO);
}

export interface FrameRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Ratio of changed pixels inside one region of the frame (for example the
 * bounding box of the control about to receive input). This is the tight,
 * element-level companion to the whole-window scene budget: an unrelated chat
 * pane may stream freely while the selected control must stay recognisable.
 *
 * Returns null when a frame cannot be decoded, so callers fail closed.
 */
export function regionChangeRatio(
  before: Uint8Array,
  after: Uint8Array,
  region: FrameRegion,
  options: FrameComparisonOptions = {},
): number | null {
  const first = decodeCached(before);
  const second = decodeCached(after);
  if (!first || !second) return null;
  if (first.width !== second.width || first.height !== second.height || first.channels !== second.channels) {
    return null;
  }

  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(first.width, Math.ceil(region.x + region.width));
  const bottom = Math.min(first.height, Math.ceil(region.y + region.height));
  if (right <= left || bottom <= top) return null;

  const channelDelta = options.channelDelta ?? DEFAULT_FRAME_CHANNEL_DELTA;
  const comparedChannels = first.channels === 4 ? 3 : first.channels;
  const sampleBudget = options.sampleBudget ?? 4_096;
  const area = (right - left) * (bottom - top);
  const step = Math.max(1, Math.floor(Math.sqrt(area / Math.max(1, sampleBudget))));

  let sampled = 0;
  let changed = 0;
  for (let y = top; y < bottom; y += step) {
    const rowStart = y * first.width * first.channels;
    for (let x = left; x < right; x += step) {
      const index = rowStart + x * first.channels;
      let differs = false;
      for (let channel = 0; channel < comparedChannels; channel++) {
        if (Math.abs(first.pixels[index + channel] - second.pixels[index + channel]) > channelDelta) {
          differs = true;
          break;
        }
      }
      sampled += 1;
      if (differs) changed += 1;
    }
  }
  if (sampled === 0) return null;
  return changed / sampled;
}
