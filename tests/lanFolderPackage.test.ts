import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FOLDER_MAGIC, FOLDER_PACKAGE_MAX_BYTES, FOLDER_MANIFEST_MAX_BYTES,
  FOLDER_MAX_FILES, inspectFolderPackage, packFolder, unpackFolderPackage,
  validateFolderRelativePath, type FolderManifest,
} from "../src/core/lanRemote/folderPackage.js";

let sandbox: string;
let source: string;
let output: string;
const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
function packageWith(manifest: unknown, content = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(manifest), "utf8");
  const header = Buffer.alloc(FOLDER_MAGIC.length + 4);
  FOLDER_MAGIC.copy(header);
  header.writeUInt32BE(json.length, FOLDER_MAGIC.length);
  return Buffer.concat([header, json, content]);
}
function one(relative: string, content = Buffer.from("abc")): Buffer {
  return packageWith({ version: 1, files: [{ path: relative, size: content.length,
    sha256: digest(content) }] }, content);
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "sa-folder-package-"));
  source = path.join(sandbox, "source");
  output = path.join(sandbox, "output");
  await fs.mkdir(source);
  await fs.mkdir(output);
});
afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("SAFOLDER1 deterministic bounded cross-platform package", () => {
  it("packs deterministically in manifest order, validates raw byte layout and unpacks uniquely", async () => {
    await fs.mkdir(path.join(source, "docs", "reports"), { recursive: true });
    await fs.writeFile(path.join(source, "z.txt"), "Zulu");
    await fs.writeFile(path.join(source, "docs", "reports", "A.txt"), "Alpha");
    await fs.writeFile(path.join(source, "empty.bin"), "");
    const first = await packFolder(source);
    const second = await packFolder(source);
    expect(first.equals(second)).toBe(true);
    expect(first.subarray(0, FOLDER_MAGIC.length).toString("ascii")).toBe("SAFOLDER1");
    expect(FOLDER_MAGIC.length).toBe(9); // The specification's "8-byte" label is a typo.
    const jsonLength = first.readUInt32BE(FOLDER_MAGIC.length);
    expect(jsonLength).toBeLessThan(FOLDER_MANIFEST_MAX_BYTES);
    const manifest: FolderManifest = JSON.parse(first.subarray(13, 13 + jsonLength).toString("utf8"));
    expect(manifest).toEqual({
      version: 1,
      files: [
        { path: "docs/reports/A.txt", size: 5, sha256: digest(Buffer.from("Alpha")) },
        { path: "empty.bin", size: 0, sha256: digest(Buffer.alloc(0)) },
        { path: "z.txt", size: 4, sha256: digest(Buffer.from("Zulu")) },
      ],
    });
    expect(first.subarray(13 + jsonLength).toString()).toBe("AlphaZulu");
    expect(inspectFolderPackage(first)).toEqual(manifest);
    const unpacked = await unpackFolderPackage(first, output);
    expect(unpacked.manifest).toEqual(manifest);
    expect(unpacked.files).toHaveLength(3);
    expect(await fs.readFile(path.join(unpacked.directory, "docs/reports/A.txt"), "utf8")).toBe("Alpha");
    expect(await fs.readFile(path.join(unpacked.directory, "empty.bin"))).toEqual(Buffer.alloc(0));
    const another = await unpackFolderPackage(first, output);
    expect(another.directory).not.toBe(unpacked.directory);
    expect((await fs.readdir(output)).length).toBe(2);
  });

  it("refuses every class of traversal, windows aliases, sensitive or hidden basename", () => {
    const paths = [
      "../escape", "a/../b", "./a", "a/./b", "a//b", "/root/file",
      "C:/Users/owner/file", "a\\b", "a/drive:secret",
      "a/.env", ".git/config", "a/.ssh/id_rsa", "a/secret.txt",
      "credentials.json", "a/passwords.csv", "id_ed25519", "private-key.pem",
      "wallet.kdbx", "CON", "NUL.txt", "dir/COM1.log", "a/trailing.",
      "a/trailing ", "a/new\nline.txt", "a/control\u007f.txt",
      "a/☃.txt", "a/" + "d/".repeat(9) + "file.txt",
    ];
    for (const relative of paths) {
      expect(() => validateFolderRelativePath(relative), relative).toThrow();
      expect(() => inspectFolderPackage(one(relative)), relative).toThrow();
    }
    expect(validateFolderRelativePath("reports/Q1/summary-2026 (final).txt"))
      .toBe("reports/Q1/summary-2026 (final).txt");
  });

  it("rejects bad magic, malformed lengths, UTF-8, JSON and trailing bytes", () => {
    const valid = one("hello.txt");
    const wrongMagic = Buffer.from(valid); wrongMagic[0] = 88;
    const largeManifest = Buffer.from(valid); largeManifest.writeUInt32BE(FOLDER_MANIFEST_MAX_BYTES + 1, 9);
    const truncatedManifest = Buffer.from(valid); truncatedManifest.writeUInt32BE(valid.length, 9);
    const utf8 = Buffer.from(valid); utf8[13] = 0xff;
    for (const bytes of [
      Buffer.alloc(0), wrongMagic, largeManifest, truncatedManifest, utf8,
      Buffer.concat([valid, Buffer.from([0])]), valid.subarray(0, -1),
      packageWith({ version: 2, files: [] }), packageWith({ version: 1, files: [] }),
      packageWith({ version: 1, files: [], unexpected: 1 }),
      Buffer.concat([FOLDER_MAGIC, Buffer.from([0, 0, 0, 1, 0x7b])]),
    ]) expect(() => inspectFolderPackage(bytes)).toThrow();
  });

  it("checks digest of every file before extraction and never leaves a directory on corrupt input", async () => {
    const valid = one("report.txt", Buffer.from("original"));
    const corrupted = Buffer.from(valid); corrupted[corrupted.length - 1] ^= 0xff;
    expect(() => inspectFolderPackage(corrupted)).toThrow(/SHA-256/);
    await expect(unpackFolderPackage(corrupted, output)).rejects.toThrow(/SHA-256/);
    expect(await fs.readdir(output)).toEqual([]);
  });

  it("refuses duplicate/case-colliding paths, directory collisions, invalid hashes and numbers", () => {
    const content = Buffer.from("hello");
    const entry = (p: string, size = 0, sha256 = digest(Buffer.alloc(0))) => ({ path: p, size, sha256 });
    for (const files of [
      [entry("A.txt"), entry("a.TXT")],
      [entry("x"), entry("x/file.txt")],
      [entry("one.txt", 1.5)],
      [entry("one.txt", -1)],
      [entry("one.txt", 4, "a".repeat(63))],
      [entry("one.txt", 5, digest(content))],
      Array.from({ length: FOLDER_MAX_FILES + 1 }, (_, i) => entry("file" + i + ".txt")),
    ]) expect(() => inspectFolderPackage(packageWith({ version: 1, files }))).toThrow();
    expect(() => inspectFolderPackage(packageWith({
      version: 1, files: [{ ...entry("hello.txt"), extra: "override" }],
    }))).toThrow();
  });

  it("enforces size limits for actual package overhead and refuses 65 selected files", async () => {
    await fs.writeFile(path.join(source, "huge.bin"), Buffer.alloc(FOLDER_PACKAGE_MAX_BYTES));
    await expect(packFolder(source)).rejects.toThrow(/4 MiB/);
    expect(() => inspectFolderPackage(Buffer.alloc(FOLDER_PACKAGE_MAX_BYTES + 1))).toThrow();
    await fs.rm(path.join(source, "huge.bin"));
    for (let i = 0; i <= FOLDER_MAX_FILES; i++) {
      await fs.writeFile(path.join(source, "f" + i + ".txt"), "x");
    }
    await expect(packFolder(source)).rejects.toThrow(/count limit/);
  });

  it("fails closed on hidden entries, sensitive content and unsupported empty directories", async () => {
    const hiddenRoot = path.join(sandbox, ".hidden-root");
    await fs.mkdir(hiddenRoot);
    await fs.writeFile(path.join(hiddenRoot, "okay.txt"), "no export");
    await expect(packFolder(hiddenRoot)).rejects.toThrow(/hidden|sensitive/i);
    await fs.writeFile(path.join(source, ".env"), "hidden");
    await expect(packFolder(source)).rejects.toThrow();
    await fs.rm(path.join(source, ".env"));
    await fs.writeFile(path.join(source, "passwords.txt"), "secret");
    await expect(packFolder(source)).rejects.toThrow();
    await fs.rm(path.join(source, "passwords.txt"));
    await fs.mkdir(path.join(source, "empty"));
    await expect(packFolder(source)).rejects.toThrow(/Empty directories/);
  });

  it("refuses symlink files and symlink extraction parent", async () => {
    const outside = path.join(sandbox, "outside.txt");
    await fs.writeFile(outside, "private");
    try {
      await fs.symlink(outside, path.join(source, "linked.txt"));
    } catch (error) {
      // Windows non-developer accounts may lack SeCreateSymbolicLinkPrivilege.
      if (process.platform === "win32") return;
      throw error;
    }
    await expect(packFolder(source)).rejects.toThrow(/Symlink/);
    const alias = path.join(sandbox, "alias");
    try {
      await fs.symlink(output, alias, process.platform === "win32" ? "junction" : "dir");
      await expect(unpackFolderPackage(one("ok.txt"), alias)).rejects.toThrow(/non-symlink/);
    } finally {
      await fs.rm(alias, { force: true });
    }
  });
});

