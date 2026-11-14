import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  verifyWindowsRemoteNativePackaging, windowsNativeCiContext, WINDOWS_UIA_RELATIVE_DIR,
  type WindowsNativeBuildContext,
} from "../../scripts/verify-standalone-windows.js";

const context: WindowsNativeBuildContext = {
  commitSha: "a".repeat(40), workflowRunId: "43350949841",
};
const cleanup: string[] = [];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function windowsDll(machine = 0x8664, optionalMagic = 0x20b, characteristics = 0x2000): Buffer {
  const bytes = Buffer.alloc(32_768);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(machine, 0x84);
  bytes.writeUInt16LE(2, 0x86); // NumberOfSections
  bytes.writeUInt16LE(characteristics, 0x96); // IMAGE_FILE_DLL
  bytes.writeUInt16LE(optionalMagic, 0x98); // PE32+ for x64
  return bytes;
}
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-uia-verify-test-"));
  cleanup.push(base);
  const source = path.join(base, "native", "desktop-live-windows-input", "windowsRemoteSemantic.cpp");
  const directory = path.join(base, "dist", WINDOWS_UIA_RELATIVE_DIR);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(source, "// native UI Automation source\n" + "x".repeat(2000));
  const dll = path.join(directory, "winremote.dll");
  const receipt = path.join(directory, "winremote.sha256");
  const provenance = path.join(directory, "winremote.provenance.json");
  async function stamp(bytes = windowsDll(), overrides: Record<string, unknown> = {}) {
    await fs.writeFile(dll, bytes);
    await fs.writeFile(receipt, sha(bytes) + "\n", "ascii");
    const sourceBytes = await fs.readFile(source);
    await fs.writeFile(provenance, JSON.stringify({
      schemaVersion: 1,
      binary: "winremote.dll",
      source: "native/desktop-live-windows-input/windowsRemoteSemantic.cpp",
      sourceSha256: sha(sourceBytes),
      dllSha256: sha(bytes),
      commitSha: context.commitSha,
      workflowRunId: context.workflowRunId,
      runnerOS: "Windows",
      runnerEnvironment: "github-hosted",
      ...overrides,
    }) + "\n");
  }
  await stamp();
  return { source, directory, dll, receipt, provenance, stamp };
}
afterEach(async () => {
  for (const target of cleanup.splice(0)) await fs.rm(target, { recursive: true, force: true });
});

describe("Windows UIA standalone PE x64 receipt and trusted-source gate", () => {
  it("accepts a valid PE32+ AMD64 DLL, exact source and bound workflow receipt", async () => {
    const f = await fixture();
    expect(verifyWindowsRemoteNativePackaging(f.directory, f.source, context)).toBe(sha(await fs.readFile(f.dll)));
  });

  it("fails closed when the DLL or SHA receipt or provenance is missing", async () => {
    for (const field of ["dll", "receipt", "provenance"] as const) {
      const f = await fixture();
      await fs.rm(f[field]);
      expect(() => verifyWindowsRemoteNativePackaging(f.directory, f.source, context)).toThrow();
    }
  });

  it("detects byte tampering even when filename is unchanged", async () => {
    const f = await fixture();
    const bytes = await fs.readFile(f.dll);
    bytes[2000] ^= 0x80;
    await fs.writeFile(f.dll, bytes);
    expect(() => verifyWindowsRemoteNativePackaging(f.directory, f.source, context))
      .toThrow(/checksum mismatch/i);
  });

  it("denies x86, ARM64, PE32 and EXE binaries even with newly forged matching checksums", async () => {
    const scenarios = [
      windowsDll(0x14c), windowsDll(0xaa64), windowsDll(0x8664, 0x10b),
      windowsDll(0x8664, 0x20b, 0x0002),
    ];
    for (const bytes of scenarios) {
      const f = await fixture();
      await f.stamp(bytes);
      expect(() => verifyWindowsRemoteNativePackaging(f.directory, f.source, context))
        .toThrow(/PE x64 DLL/);
    }
  });

  it("denies altered compiler source even if DLL and receipt still match", async () => {
    const f = await fixture();
    await fs.appendFile(f.source, "changed");
    expect(() => verifyWindowsRemoteNativePackaging(f.directory, f.source, context))
      .toThrow(/provenance/);
  });

  it("denies bogus CI identities, swapped SHA, extra metadata and unexpected runner", async () => {
    for (const override of [
      { commitSha: "b".repeat(40) }, { workflowRunId: "99" },
      { dllSha256: "0".repeat(64) }, { runnerEnvironment: "self-hosted" },
      { newField: "surprise" },
    ]) {
      const f = await fixture();
      await f.stamp(windowsDll(), override);
      expect(() => verifyWindowsRemoteNativePackaging(f.directory, f.source, context))
        .toThrow(/provenance/);
    }
  });

  it("denies malformed receipt, invalid PE header and symlinked payload", async () => {
    const a = await fixture();
    await fs.writeFile(a.receipt, "f".repeat(64) + " extra\n");
    expect(() => verifyWindowsRemoteNativePackaging(a.directory, a.source, context)).toThrow();

    const b = await fixture();
    const bad = windowsDll();
    bad.writeUInt32LE(0xfffffff0, 0x3c);
    await b.stamp(bad);
    expect(() => verifyWindowsRemoteNativePackaging(b.directory, b.source, context)).toThrow(/PE x64 DLL/);

    const c = await fixture();
    await fs.rename(c.dll, c.dll + ".original");
    await fs.symlink(c.dll + ".original", c.dll, "file");
    expect(() => verifyWindowsRemoteNativePackaging(c.directory, c.source, context))
      .toThrow(/regular file/);
  });

  it("will not accept untrusted local packaging identity", () => {
    expect(() => windowsNativeCiContext({
      GITHUB_ACTIONS: "false", RUNNER_OS: "Windows", RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_SHA: context.commitSha, GITHUB_RUN_ID: context.workflowRunId,
    })).toThrow();
    expect(() => windowsNativeCiContext({
      GITHUB_ACTIONS: "true", RUNNER_OS: "Windows", RUNNER_ENVIRONMENT: "self-hosted",
      GITHUB_SHA: context.commitSha, GITHUB_RUN_ID: context.workflowRunId,
    })).toThrow();
  });

  it("wires fresh source build before prepare, verify and actual NSIS archive audit in both workflows", async () => {
    const root = process.cwd();
    for (const workflow of [
      ".github/workflows/release-windows-standalone.yml",
      ".github/workflows/tray-build.yml",
    ]) {
      const text = await fs.readFile(path.join(root, workflow), "utf8");
      const build = text.indexOf("./scripts/build-desktop-live-windows-semantic.ps1");
      const prepare = text.indexOf("bun run installer:prepare");
      const nsis = text.indexOf("bun run installer:package");
      const audit = text.indexOf("./scripts/build-desktop-live-windows-semantic-audit-nsis.ps1");
      expect(build).toBeGreaterThan(0);
      expect(prepare).toBeGreaterThan(build);
      expect(nsis).toBeGreaterThan(prepare);
      expect(audit).toBeGreaterThan(nsis);
    }
    const config = await fs.readFile(path.join(root,
      "apps/superagent-tray/src-tauri/tauri.standalone.conf.json"), "utf8");
    expect(config).toContain('"resources/standalone/": "standalone/"');
    const loader = await fs.readFile(path.join(root,
      "src/core/desktopUi/adapters/windowsRemoteSemanticNative.ts"), "utf8");
    expect(loader).toContain('"../../../../native/desktop-live-windows-input"');
    const preparation = await fs.readFile(path.join(root, "scripts/prepare-standalone-windows.ts"), "utf8");
    expect(preparation).toContain('activated: false');
    expect(preparation).toContain('path.join(stage, WINDOWS_UIA_RELATIVE_DIR)');
    expect(preparation).not.toContain('copy(path.join(root, "native", "desktop-live-windows-input")');
  });

  it.skipIf(process.platform !== "win32")("executes the NSIS archive member filter without PowerShell line-continuation errors", async () => {
    const script = await fs.readFile(path.join(process.cwd(),
      "scripts/build-desktop-live-windows-semantic-audit-nsis.ps1"), "utf8");
    const start = script.indexOf("$unexpected = @($members | Where-Object {");
    const end = script.indexOf("\nif ($unexpected.Count", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const filter = script.slice(start, end);
    const program = [
      '$ErrorActionPreference = "Stop"',
      '$expected = @("standalone/native/desktop-live-windows-input/winremote.dll", "standalone/native/desktop-live-windows-input/winremote.sha256")',
      '$members = @("standalone/native/desktop-live-windows-input/winremote.dll", "standalone/native/desktop-live-windows-input/winremote.sha256", "standalone/native/desktop-live-windows-input/winremote.obj", "other/unrelated")',
      filter,
      'if ($unexpected.Count -ne 1 -or $unexpected[0] -cne "standalone/native/desktop-live-windows-input/winremote.obj") { throw "Incorrect NSIS member filter" }',
    ].join("\n");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(program, "utf16le").toString("base64")], {
      encoding: "utf8", timeout: 15_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
