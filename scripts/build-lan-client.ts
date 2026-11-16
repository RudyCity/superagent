#!/usr/bin/env bun
/**
 * Cross-platform build script for portable SuperAgent LAN Client receivers.
 * Compiles standalone executables and packages portable archives for:
 * - Windows (x64)
 * - Linux (x64, arm64)
 * - macOS (x64, arm64)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import JSZip from "jszip";

const __dirname = import.meta.dir ?? path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "artifacts", "lan-client");
fs.mkdirSync(outDir, { recursive: true });

export interface Target {
  id: string;
  bunTarget: string;
  os: "windows" | "linux" | "macos";
  arch: "x64" | "arm64";
  binaryFile: string;
  archiveFile: string;
  internalBinaryName: string;
}

export const TARGETS: Target[] = [
  {
    id: "windows-x64",
    bunTarget: "bun-windows-x64",
    os: "windows",
    arch: "x64",
    binaryFile: "superagent-lan-client-windows-x64.exe",
    archiveFile: "superagent-lan-client-windows-x64.zip",
    internalBinaryName: "superagent-lan-client.exe",
  },
  {
    id: "linux-x64",
    bunTarget: "bun-linux-x64",
    os: "linux",
    arch: "x64",
    binaryFile: "superagent-lan-client-linux-x64",
    archiveFile: "superagent-lan-client-linux-x64.tar.gz",
    internalBinaryName: "superagent-lan-client",
  },
  {
    id: "linux-arm64",
    bunTarget: "bun-linux-arm64",
    os: "linux",
    arch: "arm64",
    binaryFile: "superagent-lan-client-linux-arm64",
    archiveFile: "superagent-lan-client-linux-arm64.tar.gz",
    internalBinaryName: "superagent-lan-client",
  },
  {
    id: "macos-x64",
    bunTarget: "bun-darwin-x64",
    os: "macos",
    arch: "x64",
    binaryFile: "superagent-lan-client-macos-x64",
    archiveFile: "superagent-lan-client-macos-x64.tar.gz",
    internalBinaryName: "superagent-lan-client",
  },
  {
    id: "macos-arm64",
    bunTarget: "bun-darwin-arm64",
    os: "macos",
    arch: "arm64",
    binaryFile: "superagent-lan-client-macos-arm64",
    archiveFile: "superagent-lan-client-macos-arm64.tar.gz",
    internalBinaryName: "superagent-lan-client",
  },
];

function sha256(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function writeChecksum(filePath: string, hash: string): void {
  const fileName = path.basename(filePath);
  fs.writeFileSync(filePath + ".sha256", `${hash}  ${fileName}\n`, "utf8");
}

function makeReadme(t: Target): string {
  const bin = t.internalBinaryName;
  if (t.os === "windows") {
    return `SuperAgent LAN Client — Windows ${t.arch} Portable Receiver
=========================================================

1. Extract and run ${bin} on the PC you want to support.
2. Launch as a normal, non-administrator Windows user in a standard Command Prompt or PowerShell.
3. Keep the terminal console visible at all times to monitor and approve incoming requests.
4. On the SuperAgent controller PC, discover or enter this PC's local LAN IPv4 address.
5. Confirm the 8-digit temporary pairing code and SHA-256 certificate fingerprint.
6. When prompted on this target console, type APPROVE to permit pairing, and APPROVE again for session access.
7. To revoke all access at any time, type 'revoke'. To exit and stop sharing, type 'stop'.

Firewall notice: If Windows Firewall blocks local connections, allow port 17845 TCP and 17846 UDP for LocalSubnet on Private networks only.
Repository guide: docs/guides/superagent-lan-client.md
`;
  } else if (t.os === "linux") {
    return `SuperAgent LAN Client — Linux ${t.arch} Portable Receiver
=======================================================

1. Extract the archive:
     tar -xzf ${t.archiveFile}
2. Mark the receiver executable:
     chmod +x ${bin}
3. Run as a standard (non-root) user in a visible terminal:
     ./${bin}
4. Keep the terminal open to monitor and approve incoming requests.
5. On the SuperAgent controller PC, connect using this PC's local LAN IP.
6. Confirm pairing code and SHA-256 TLS fingerprint.
7. Type APPROVE on this console to allow pairing and session access.
8. Type 'revoke' to cancel all paired controllers or 'stop' to terminate sharing.

Repository guide: docs/guides/superagent-lan-client.md
`;
  } else {
    return `SuperAgent LAN Client — macOS ${t.arch} Portable Receiver
=======================================================

1. Extract the archive:
     tar -xzf ${t.archiveFile}
2. Mark the receiver executable:
     chmod +x ${bin}
3. Run as a standard user in Terminal:
     ./${bin}
4. Keep the Terminal window visible to monitor and approve requests.
5. On the SuperAgent controller Mac/PC, connect using this Mac's local LAN IP.
6. Verify the pairing code and SHA-256 TLS fingerprint.
7. Type APPROVE in this terminal to authorize connection.
8. Type 'revoke' to clear authorizations or 'stop' to exit.

Repository guide: docs/guides/superagent-lan-client.md
`;
  }
}

async function createZipArchive(destPath: string, files: { name: string; content: Buffer }[]) {
  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.name, f.content, {
      date: new Date("2026-01-01T00:00:00Z"),
      unixPermissions: f.name.endsWith(".exe") || !f.name.includes(".") ? "755" : "644",
    });
  }
  const buf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  fs.writeFileSync(destPath, buf);
}

function createTarGzArchive(destPath: string, files: { name: string; content: Buffer }[]) {
  const stage = path.join(os.tmpdir(), "lan-tar-stage-" + crypto.randomBytes(6).toString("hex"));
  fs.mkdirSync(stage, { recursive: true });
  try {
    const names: string[] = [];
    for (const f of files) {
      const p = path.join(stage, f.name);
      fs.writeFileSync(p, f.content);
      names.push(f.name);
    }
    tar.c({
      gzip: true,
      file: destPath,
      cwd: stage,
      sync: true,
      portable: true,
    }, names);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function buildTarget(t: Target): Promise<{ binPath: string; binHash: string; archivePath?: string; archiveHash?: string }> {
  const binPath = path.join(outDir, t.binaryFile);
  console.log(`\nCompiling ${t.id} standalone binary (${t.bunTarget})...`);
  const build = spawnSync(process.execPath, [
    "build",
    "--compile",
    `--target=${t.bunTarget}`,
    "src/lanClient.ts",
    "--outfile",
    binPath,
  ], {
    cwd: root,
    stdio: "inherit",
    timeout: 300_000,
  });

  if (build.error || build.status !== 0) {
    throw new Error(`Build failed for ${t.id}: ${build.error?.message || String(build.status)}`);
  }

  const binSize = fs.statSync(binPath).size;
  if (binSize < 100_000) {
    throw new Error(`Output binary for ${t.id} is suspiciously small: ${binSize} bytes`);
  }
  const binHash = sha256(binPath);
  writeChecksum(binPath, binHash);
  console.log(`✓ ${t.binaryFile}: ${binSize} bytes | SHA-256: ${binHash}`);

  // For Windows x64, also copy to superagent-lan-client.exe for compatibility
  if (t.id === "windows-x64") {
    const compatPath = path.join(outDir, "superagent-lan-client.exe");
    fs.copyFileSync(binPath, compatPath);
    writeChecksum(compatPath, binHash);
  }

  const archivePath = path.join(outDir, t.archiveFile);
  const binBytes = fs.readFileSync(binPath);
  const readmeBytes = Buffer.from(makeReadme(t), "utf8");

  console.log(`Packaging archive ${t.archiveFile}...`);
  if (t.archiveFile.endsWith(".zip")) {
    await createZipArchive(archivePath, [
      { name: t.internalBinaryName, content: binBytes },
      { name: "README.txt", content: readmeBytes },
    ]);
  } else {
    createTarGzArchive(archivePath, [
      { name: t.internalBinaryName, content: binBytes },
      { name: "README.txt", content: readmeBytes },
    ]);
  }

  const arcSize = fs.statSync(archivePath).size;
  const archiveHash = sha256(archivePath);
  writeChecksum(archivePath, archiveHash);
  console.log(`✓ ${t.archiveFile}: ${arcSize} bytes | SHA-256: ${archiveHash}`);

  return { binPath, binHash, archivePath, archiveHash };
}

async function packageWindowsGuiPortable(): Promise<{ path: string; hash: string } | null> {
  const guiExe = path.join(root, "apps", "superagent-lan-windows", "src-tauri", "target", "release", "superagent-lan-windows.exe");
  const companion = path.join(root, "apps", "superagent-lan-windows", "src-tauri", "resources", "superagent-lan-client.exe");
  if (!fs.existsSync(guiExe) || !fs.existsSync(companion)) {
    console.log("Windows GUI release binary or companion missing, skipping GUI portable archive.");
    return null;
  }

  const archiveName = "superagent-lan-windows-portable-x64.zip";
  const archivePath = path.join(outDir, archiveName);
  console.log(`\nPackaging portable Windows GUI companion (${archiveName})...`);

  const guiBytes = fs.readFileSync(guiExe);
  const companionBytes = fs.readFileSync(companion);
  const readme = `SuperAgent LAN Client — Windows x64 Portable GUI Companion
==========================================================

1. Extract this archive anywhere (e.g., C:\\Tools\\SuperAgent LAN Client).
2. Run superagent-lan-windows.exe directly — no installer or administrator rights required!
3. Features:
   - Full Cyberpunk custom titlebar with seamless window drag, minimize, maximize, and close.
   - System Tray integration: closing the window keeps the receiver running in background tray.
   - Restoring or quitting easily accessible via system tray icon and context menu.
   - Clean scrollable layout with official SuperAgent Tray icons.
4. Note: Keep the 'binaries' folder intact next to superagent-lan-windows.exe.
`;

  await createZipArchive(archivePath, [
    { name: "superagent-lan-windows.exe", content: guiBytes },
    { name: "binaries/superagent-lan-client.exe", content: companionBytes },
    { name: "README.txt", content: Buffer.from(readme, "utf8") },
  ]);

  const arcSize = fs.statSync(archivePath).size;
  const hash = sha256(archivePath);
  writeChecksum(archivePath, hash);
  console.log(`✓ ${archiveName}: ${arcSize} bytes | SHA-256: ${hash}`);
  return { path: archivePath, hash };
}

async function main() {
  const targetArg = process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length);
  const targets = targetArg
    ? TARGETS.filter((t) => t.id === targetArg || t.os === targetArg)
    : TARGETS;

  if (targetArg && targets.length === 0) {
    throw new Error(`Unknown target '${targetArg}'. Valid options: all, ${TARGETS.map((t) => t.id).join(", ")}`);
  }

  console.log("=================================================");
  console.log("  SuperAgent Portable LAN Client Multi-OS Build  ");
  console.log("=================================================");
  console.log(`Building targets: ${targets.map((t) => t.id).join(", ")}`);

  const ledger: { file: string; size: number; hash: string }[] = [];

  for (const t of targets) {
    const res = await buildTarget(t);
    ledger.push({
      file: path.basename(res.binPath),
      size: fs.statSync(res.binPath).size,
      hash: res.binHash,
    });
    if (res.archivePath && res.archiveHash) {
      ledger.push({
        file: path.basename(res.archivePath),
        size: fs.statSync(res.archivePath).size,
        hash: res.archiveHash,
      });
    }
  }

  // Also include portable Windows GUI companion if on Windows or --gui requested
  const gui = await packageWindowsGuiPortable();
  if (gui) {
    ledger.push({
      file: path.basename(gui.path),
      size: fs.statSync(gui.path).size,
      hash: gui.hash,
    });
  }

  // Write master SHA256SUMS file
  const sha256SumsPath = path.join(outDir, "SHA256SUMS");
  const lines = ledger.map((item) => `${item.hash}  ${item.file}`);
  fs.writeFileSync(sha256SumsPath, lines.join("\n") + "\n", "utf8");

  console.log("\n=================================================");
  console.log("               BUILD SUMMARY LEDGER              ");
  console.log("=================================================");
  for (const item of ledger) {
    const mb = (item.size / (1024 * 1024)).toFixed(2);
    console.log(`${item.file.padEnd(46)} | ${mb.padStart(7)} MB | ${item.hash}`);
  }
  console.log(`\nMaster checksum file written: ${sha256SumsPath}`);
}

const isDirectRun = import.meta.main || (process.argv[1] && path.resolve(process.argv[1]).endsWith("build-lan-client.ts"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("\n❌ LAN Client build failed:", err);
    process.exit(1);
  });
}
