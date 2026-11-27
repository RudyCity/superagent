import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import {
  decodePngFrame,
  frameChangeRatio,
  framesEquivalent,
  regionChangeRatio,
} from "../../src/core/desktopUi/frames.js";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

type Paint = (x: number, y: number) => [number, number, number];

/** Encode a truecolor PNG so frame comparisons run against real pixel data. */
function png(width: number, height: number, paint: Paint): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const index = y * (stride + 1) + 1 + x * 3;
      raw[index] = r;
      raw[index + 1] = g;
      raw[index + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const solid = (width: number, height: number, colour: [number, number, number] = [250, 250, 250]) =>
  png(width, height, () => colour);

/** Same canvas with a small moving marker: a caret/blink equivalent. */
function animated(width: number, height: number, markerX: number): Buffer {
  return png(width, height, (x, y) =>
    x >= markerX && x < markerX + 6 && y >= 10 && y < 16 ? [20, 20, 20] : [250, 250, 250]);
}

describe("desktop frame comparison", () => {
  it("decodes a truecolor PNG capture", () => {
    const frame = decodePngFrame(solid(24, 12));
    expect(frame).toMatchObject({ width: 24, height: 12, channels: 3 });
    expect(frame?.pixels).toHaveLength(24 * 12 * 3);
  });

  it("treats byte-identical captures as equivalent", () => {
    const frame = solid(40, 20);
    expect(framesEquivalent(frame, frame)).toBe(true);
    expect(frameChangeRatio(frame, frame)).toBe(0);
  });

  it("tolerates a small animated region on a live window", () => {
    const before = animated(240, 160, 10);
    const after = animated(240, 160, 30);
    const ratio = frameChangeRatio(before, after);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeLessThan(0.01);
    expect(framesEquivalent(before, after)).toBe(true);
  });

  it("accepts a large streaming repaint that stays under the scene-change budget", () => {
    const before = solid(240, 160);
    // Bottom band repainted (about 9% of rows) as chat content streams in.
    const after = png(240, 160, (_x, y) => (y >= 146 ? [30, 30, 30] : [250, 250, 250]));
    const ratio = frameChangeRatio(before, after);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeLessThan(0.1);
    expect(framesEquivalent(before, after)).toBe(true);
  });

  it("rejects a gross visual change such as a dialog or navigation", () => {
    const before = solid(240, 160);
    const after = png(240, 160, (x) =>
      x < 120 ? [250, 250, 250] : [10, 10, 120]);
    const ratio = frameChangeRatio(before, after);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThan(0.4);
    expect(framesEquivalent(before, after)).toBe(false);
  });

  it("rejects captures with different dimensions", () => {
    expect(framesEquivalent(solid(40, 20), solid(41, 20))).toBe(false);
    expect(frameChangeRatio(solid(40, 20), solid(40, 21))).toBe(1);
  });

  it("ignores sub-threshold channel noise but honours a custom tolerance", () => {
    const base = solid(40, 20, [100, 100, 100]);
    const noisy = solid(40, 20, [104, 100, 100]);
    expect(frameChangeRatio(base, noisy)).toBe(0);
    expect(frameChangeRatio(base, noisy, { channelDelta: 1 })).toBe(1);
  });

  it("fails closed for bytes that are not decodable PNG frames", () => {
    const fake = Buffer.alloc(25);
    SIGNATURE.copy(fake, 0);
    fake.writeUInt32BE(100, 16);
    fake.writeUInt32BE(50, 20);
    expect(decodePngFrame(fake)).toBeNull();
    expect(framesEquivalent(fake, Buffer.from(fake))).toBe(true);
    const other = Buffer.from(fake);
    other[24] = 1;
    expect(framesEquivalent(fake, other)).toBe(false);
  });

  it("measures only the selected control region", () => {
    const before = solid(80, 60);
    const after = png(80, 60, (x, y) =>
      x >= 50 && x < 70 && y >= 40 && y < 60 ? [10, 10, 120] : [250, 250, 250]);
    // Whole window changed only 8%, but the control region is fully replaced.
    expect(frameChangeRatio(before, after)!).toBeLessThan(0.12);
    expect(regionChangeRatio(before, after, { x: 50, y: 40, width: 20, height: 20 })).toBe(1);
    expect(regionChangeRatio(before, after, { x: 0, y: 0, width: 20, height: 20 })).toBe(0);
  });

  it("returns null for an unusable region or an undecodable frame", () => {
    const before = solid(40, 20);
    const after = solid(40, 20);
    expect(regionChangeRatio(before, after, { x: 0, y: 0, width: 0, height: 0 })).toBeNull();
    expect(regionChangeRatio(before, after, { x: 500, y: 500, width: 10, height: 10 })).toBeNull();
    const fake = Buffer.alloc(25);
    SIGNATURE.copy(fake, 0);
    expect(regionChangeRatio(before, fake, { x: 0, y: 0, width: 5, height: 5 })).toBeNull();
  });
});
