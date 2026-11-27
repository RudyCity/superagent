import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_HOST_IMAGE_MAX_BYTES,
  verifyDesktopHostArtifactPair,
  resolveDesktopHostArtifactDirectory,
} from "../../src/core/desktopUi/adapters/desktopHostArtifact.js";
import { DesktopUiError } from "../../src/core/desktopUi/errors.js";

const PE_OFFSET = 0x80;
const MIN_IMAGE_BYTES = 16 * 1024;

interface PeOptions {
  size?: number;
  machine?: number;
  magic?: number;
  mz?: boolean;
  pe?: boolean;
}

/** Synthetic Windows PE image; enough structure for the fixed header checks. */
function peImage(options: PeOptions = {}): Buffer {
  const size = options.size ?? MIN_IMAGE_BYTES;
  const buffer = Buffer.alloc(size);
  if (options.mz !== false) buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(PE_OFFSET, 0x3c);
  if (options.pe !== false) buffer.write("PE\u0000\u0000", PE_OFFSET, "ascii");
  buffer.writeUInt16LE(options.machine ?? 0x8664, PE_OFFSET + 4);
  buffer.writeUInt16LE(options.magic ?? 0x20b, PE_OFFSET + 24);
  return buffer;
}

function digestOf(binary: Buffer): string {
  return createHash("sha256").update(binary).digest("hex");
}

const directories: string[] = [];

async function scratchPair(binary: Buffer, digest: string): Promise<{ exe: string; digestPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "superagent-desktop-host-artifact-"));
  directories.push(dir);
  const exe = path.join(dir, "desktop-host.exe");
  const digestPath = path.join(dir, "desktop-host.sha256");
  await writeFile(exe, binary);
  await writeFile(digestPath, `${digest}\n`, "ascii");
  return { exe, digestPath };
}

function expectFailure(action: () => unknown, pattern: RegExp): void {
  try {
    action();
    throw new Error("expected artifact verification to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopUiError);
    expect((error as DesktopUiError).code).toBe("DESKTOP_UI_UNAVAILABLE");
    expect((error as Error).message).toMatch(pattern);
  }
}

afterEach(async () => {
  while (directories.length > 0) {
    const dir = directories.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("desktop host artifact verification", () => {
  it("accepts a bounded x64 PE image whose sha256 sidecar matches", async () => {
    const binary = peImage();
    const pair = await scratchPair(binary, digestOf(binary));
    expect(verifyDesktopHostArtifactPair(pair.exe, pair.digestPath)).toBe(pair.exe);
  });

  it("returns null when neither the executable nor the digest exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "superagent-desktop-host-artifact-"));
    directories.push(dir);
    expect(
      verifyDesktopHostArtifactPair(path.join(dir, "desktop-host.exe"), path.join(dir, "desktop-host.sha256")),
    ).toBeNull();
  });

  it("rejects an incomplete pair even when the executable itself is valid", async () => {
    const binary = peImage();
    const pair = await scratchPair(binary, digestOf(binary));
    await rm(pair.digestPath);
    expectFailure(() => verifyDesktopHostArtifactPair(pair.exe, pair.digestPath), /incomplete/);
  });

  it("rejects an incomplete pair even when only the digest exists", async () => {
    const binary = peImage();
    const pair = await scratchPair(binary, digestOf(binary));
    await rm(pair.exe);
    expectFailure(() => verifyDesktopHostArtifactPair(pair.exe, pair.digestPath), /incomplete/);
  });

  it("rejects a digest that does not match the image", async () => {
    const binary = peImage();
    const pair = await scratchPair(binary, "0".repeat(64));
    expectFailure(() => verifyDesktopHostArtifactPair(pair.exe, pair.digestPath), /checksum mismatch/);
  });

  it("rejects a non-hexadecimal digest", async () => {
    const binary = peImage();
    const pair = await scratchPair(binary, "z".repeat(64));
    expectFailure(() => verifyDesktopHostArtifactPair(pair.exe, pair.digestPath), /checksum is invalid/);
  });

  it("rejects a wrong-architecture PE image", async () => {
    const binary = peImage({ machine: 0x14c });
    const pair = await scratchPair(binary, digestOf(binary));
    expectFailure(() => verifyDesktopHostArtifactPair(pair.exe, pair.digestPath), /not a Windows x64 executable/);
  });

  it("rejects a PE image without the MZ signature", async () => {
    const binary = peImage({ mz: false });
    const pair = await scratchPair(binary, digestOf(binary));
    expectFailure(() => verifyDesktopHostArtifactPair(pair.exe, pair.digestPath), /not a Windows x64 executable/);
  });

  it("rejects an image above the fixed size bound", async () => {
    const binary = peImage({ size: DESKTOP_HOST_IMAGE_MAX_BYTES + 1 });
    const pair = await scratchPair(binary, digestOf(binary));
    expectFailure(() => verifyDesktopHostArtifactPair(pair.exe, pair.digestPath), /size bounds/);
  });

  it("rejects a truncated image below the fixed size bound", async () => {
    const binary = peImage({ size: 1024 });
    const pair = await scratchPair(binary, digestOf(binary));
    expectFailure(() => verifyDesktopHostArtifactPair(pair.exe, pair.digestPath), /size bounds/);
  });

  it("rejects an undersized digest sidecar before trusting its contents", async () => {
    const binary = peImage();
    const pair = await scratchPair(binary, digestOf(binary));
    await writeFile(pair.digestPath, "abc\n", "ascii");
    expectFailure(() => verifyDesktopHostArtifactPair(pair.exe, pair.digestPath), /size bounds/);
  });
});

describe("desktop host artifact directory resolution", () => {
  const root = path.join(process.cwd(), "checkout");

  it("resolves the source layout to the built dist payload", () => {
    const modulePath = path.join(root, "src", "core", "desktopUi", "adapters", "desktopHostArtifact.ts");
    expect(resolveDesktopHostArtifactDirectory(modulePath)).toBe(
      path.join(root, "dist", "native", "desktop-host"),
    );
  });

  it("resolves the built layout to the built dist payload", () => {
    const modulePath = path.join(root, "dist", "core", "desktopUi", "adapters", "desktopHostArtifact.js");
    expect(resolveDesktopHostArtifactDirectory(modulePath)).toBe(
      path.join(root, "dist", "native", "desktop-host"),
    );
  });

  it("refuses an unexpected module layout", () => {
    const modulePath = path.join(root, "lib", "desktopHostArtifact.ts");
    expect(() => resolveDesktopHostArtifactDirectory(modulePath)).toThrow(/Unexpected Core module layout/);
  });

  it("refuses an unknown tree root instead of probing parent directories", () => {
    const modulePath = path.join(root, "build", "core", "desktopUi", "adapters", "desktopHostArtifact.js");
    expect(() => resolveDesktopHostArtifactDirectory(modulePath)).toThrow(/Unknown Desktop UI host module layout/);
  });
});
