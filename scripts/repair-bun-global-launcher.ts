/**
 * Repair legacy npm-generated SuperAgent shims that bootstrap Node before Bun.
 * Does not terminate or restart running processes. All changed shims get backups.
 *
 *   bun scripts/repair-bun-global-launcher.ts           # inspect first PATH hit
 *   bun scripts/repair-bun-global-launcher.ts --apply    # repair owned legacy shims
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MARKER = "SuperAgent Bun-native shim";
const args = process.argv.slice(2);
const apply = args.includes("--apply");

function selectedShimDirectory(): string {
  if (process.platform !== "win32") throw new Error("Windows global shims only; the Unix CLI uses a Bun shebang.");
  const output = execFileSync("where.exe", ["superagent"], { encoding: "utf8", timeout: 5000 });
  const selected = output.split(/\r?\n/).map(p => p.trim()).find(Boolean);
  if (!selected) throw new Error("No superagent executable found in PATH");
  return path.dirname(selected);
}

function ownedShim(body: string) {
  return /node_modules[\\/]superagent[\\/]dist[\\/]cli\.js/i.test(body);
}

export function nativeShim(ext: string, bunExe: string): string {
  if (ext === ".cmd") return [
    "@ECHO OFF", "REM " + MARKER, "SETLOCAL",
    'SET "BUN_EXE=' + bunExe + '"',
    'IF NOT EXIST "%BUN_EXE%" (',
    '  ECHO SuperAgent requires Bun at %BUN_EXE% 1>&2',
    '  EXIT /B 1',
    ')',
    '"%BUN_EXE%" "%~dp0node_modules\\superagent\\dist\\cli.js" %*',
    "EXIT /B %ERRORLEVEL%", "",
  ].join("\r\n");
  if (ext === ".ps1") return [
    "# " + MARKER,
    "$bunExe = '" + bunExe.replace(/'/g, "''") + "'",
    "if (-not (Test-Path -LiteralPath $bunExe)) { throw 'SuperAgent requires Bun; bundled launcher could not find bun.exe' }",
    '$cli = Join-Path $PSScriptRoot "node_modules/superagent/dist/cli.js"',
    "& $bunExe $cli @args",
    "exit $LASTEXITCODE", "",
  ].join("\r\n");
  return [
    "#!/bin/sh", "# " + MARKER,
    'basedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'cli="$basedir/node_modules/superagent/dist/cli.js"',
    'if command -v cygpath >/dev/null 2>&1; then cli=$(cygpath -w "$cli"); fi',
    'exec bun "$cli" "$@"', "",
  ].join("\n");
}

function main() {
  if (!process.versions.bun) throw new Error("This repair tool requires Bun.");
  const dir = selectedShimDirectory();
  const bunExe = process.execPath;
  const cli = path.join(dir, "node_modules", "superagent", "dist", "cli.js");
  if (!fs.existsSync(cli)) throw new Error("Refusing to modify a launcher without its linked SuperAgent CLI: " + cli);

  let legacy = 0;
  let repaired = 0;
  const targets = [
    { filename: "superagent", ext: "" },
    { filename: "superagent.cmd", ext: ".cmd" },
    { filename: "superagent.ps1", ext: ".ps1" },
  ];
  for (const { filename, ext } of targets) {
    const file = path.join(dir, filename);
    if (!fs.existsSync(file)) continue;
    const original = fs.readFileSync(file, "utf8");
    if (!ownedShim(original)) throw new Error("Refusing to overwrite an unknown launcher: " + file);
    if (original === nativeShim(ext, bunExe)) {
      console.log("Bun launcher OK: " + file);
      continue;
    }
    legacy++;
    console.log("Legacy Node launcher: " + file);
    if (!apply) continue;
    const backup = file + ".pre-bun.bak";
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    const temporary = file + ".bun-repair-" + process.pid + ".tmp";
    try {
      fs.writeFileSync(temporary, nativeShim(ext, bunExe), { mode: 0o755 });
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    repaired++;
    console.log("Repaired (backup: " + backup + ")");
  }
  if (legacy && !apply) {
    console.error("Legacy Node shims detected. Run with --apply to replace them with Bun-native shims.");
    process.exitCode = 1;
  } else {
    console.log("BUN_GLOBAL_LAUNCHER_OK repaired=" + repaired + " legacy=" + (legacy - repaired));
  }
}

if (import.meta.main) {
  try { main(); }
  catch (error) { console.error("Bun launcher repair blocked: " + String(error)); process.exitCode = 1; }
}
