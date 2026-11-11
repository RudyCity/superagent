/**
 * Optional native dependency preflight and operator-approved installer.
 * Never downloads arbitrary executables, invokes a shell, elevates privileges,
 * installs on service/MCP startup, or silently mutates a working machine.
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export type Dependency = "ffmpeg";
export type DependencyStatus = {
  id: Dependency;
  requiredFor: string;
  installed: boolean;
  version?: string;
  missing: string[];
};
export type InstallPlan = {
  executable: string;
  args: string[];
  label: string;
};
type SpawnProbe = (name: string, args: string[]) => { status: number | null; stdout?: string };
const PROBE_TIMEOUT_MS = 2500;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

function systemProbe(name: string, args: string[]) {
  const result = spawnSync(name, args, {
    windowsHide: true, encoding: "utf8", timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024, stdio: ["ignore","pipe","ignore"],
  });
  return { status: result.status, stdout: result.stdout || "" };
}

export function checkNativeDependencies(probe: SpawnProbe = systemProbe): DependencyStatus[] {
  const ffmpeg = probe("ffmpeg", ["-version"]);
  const ffprobe = probe("ffprobe", ["-version"]);
  const installed = ffmpeg.status === 0 && ffprobe.status === 0;
  const missing = [
    ...(ffmpeg.status === 0 ? [] : ["ffmpeg"]),
    ...(ffprobe.status === 0 ? [] : ["ffprobe"]),
  ];
  return [{
    id: "ffmpeg",
    requiredFor: "CDP session MP4 recording and media diagnostics",
    installed,
    ...(installed ? { version: ffmpeg.stdout?.split(/\r?\n/)[0]?.slice(0, 160) } : {}),
    missing,
  }];
}

export function nativeDependencyInstallPlan(
  os: NodeJS.Platform = process.platform,
  managers: ReadonlySet<string>,
  isRoot = typeof process.getuid === "function" && process.getuid() === 0,
): InstallPlan | null {
  if (os === "win32" && managers.has("winget"))
    return {
      executable: "winget",
      args: ["install", "--id", "Gyan.FFmpeg", "--exact", "--source", "winget",
        "--scope", "user", "--accept-package-agreements", "--accept-source-agreements"],
      label: "Install FFmpeg with Windows Package Manager (winget), user scope",
    };
  if (os === "darwin" && managers.has("brew"))
    return { executable: "brew", args: ["install","ffmpeg"], label: "Install FFmpeg with Homebrew" };
  if (os === "linux" && isRoot && managers.has("apt-get"))
    return { executable: "apt-get", args: ["install","-y","ffmpeg"], label: "Install FFmpeg with apt-get (current root session)" };
  if (os === "linux" && isRoot && managers.has("dnf"))
    return { executable: "dnf", args: ["install","-y","ffmpeg"], label: "Install FFmpeg with dnf (current root session)" };
  return null;
}

function detectManagers(probe: SpawnProbe = systemProbe) {
  const names = process.platform === "win32" ? ["winget"] :
    process.platform === "darwin" ? ["brew"] : ["apt-get","dnf"];
  return new Set(names.filter(name =>
    probe(process.platform === "win32" ? "where.exe" : "which", [name]).status === 0));
}

export function dependencyInstallInstructions(os: NodeJS.Platform = process.platform): string {
  if (os === "win32")
    return "Install Windows Package Manager (winget), then run: winget install --id Gyan.FFmpeg --exact --source winget";
  if (os === "darwin") return "Install Homebrew, then run: brew install ffmpeg";
  if (os === "linux") return "Install ffmpeg using your distribution package manager (e.g. sudo apt-get install ffmpeg).";
  return "Install ffmpeg and ffprobe for your operating system and ensure both appear on PATH.";
}

export async function installNativeDependencies(
  options: {
    approved: boolean;
    os?: NodeJS.Platform;
    probe?: SpawnProbe;
    plan?: InstallPlan | null;
    execute?: (plan: InstallPlan) => Promise<number>;
  },
): Promise<{ status: "already-installed" | "installed" | "failed" | "unsupported" | "declined"; message: string }> {
  const probe = options.probe ?? systemProbe;
  if (checkNativeDependencies(probe)[0].installed)
    return { status:"already-installed",message:"FFmpeg and ffprobe are already available." };
  if (!options.approved)
    return { status:"declined",message:"Installation not approved; existing SuperAgent features remain usable." };
  const os = options.os ?? process.platform;
  const plan = options.plan === undefined ?
    nativeDependencyInstallPlan(os, detectManagers(probe)) : options.plan;
  if (!plan)
    return { status:"unsupported",message:dependencyInstallInstructions(os) };
  const execute = options.execute ?? (p => new Promise<number>((resolve) => {
    const child=spawn(p.executable,p.args,{
      windowsHide: true, shell:false, stdio:"inherit",
    });
    let settled=false;
    const settle=(code:number) => { if (settled) return; settled=true;clearTimeout(deadline);resolve(code); };
    const deadline=setTimeout(() => {
      child.kill();
      settle(124);
    },INSTALL_TIMEOUT_MS);
    child.once("error",() => settle(127));
    child.once("close",code => settle(code ?? 1));
  }));
  let code: number;
  try { code=await execute(plan); }
  catch (error) {
    return { status:"failed",message:"Package manager failed to launch: "+
      String((error as Error)?.message??error).slice(0,200)+". "+dependencyInstallInstructions(os) };
  }
  if (code !== 0) return {
    status:"failed",message:"Native package manager returned exit code "+code+". "+dependencyInstallInstructions(os),
  };
  const updated=checkNativeDependencies(probe)[0];
  if (!updated.installed)
    return { status:"failed",message:"Installer finished but ffmpeg/ffprobe are not on this process PATH. Open a new terminal, then run superagent deps check." };
  return { status:"installed",message:"FFmpeg and ffprobe successfully installed and verified." };
}

export async function promptNativeDependencyInstall(
  input: Readable = process.stdin, output: Writable = process.stdout,
): Promise<void> {
  const status = checkNativeDependencies()[0];
  if (status.installed) return;
  output.write("\n[SuperAgent prerequisites] FFmpeg/ffprobe missing. Video recording is unavailable.\n");
  output.write("  " + dependencyInstallInstructions() + "\n");
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const managers=detectManagers();
  const plan=nativeDependencyInstallPlan(process.platform,managers);
  if (!plan) return;
  output.write("  Proposed: " + plan.label + "\n");
  const rl=createInterface({input,output});
  let answer="";
  try { answer=(await rl.question("  Install this dependency now? [y/N] ")).trim().toLowerCase(); }
  finally { rl.close(); }
  if (answer!=="y" && answer!=="yes") {
    output.write("  Skipped. You can run 'superagent deps install' later.\n");
    return;
  }
  const result=await installNativeDependencies({approved:true,plan});
  output.write("  " + result.message + "\n");
}

export async function handleDependenciesCli(args: string[]) {
  const action=(args[0]||"check").toLowerCase();
  if (!["check","install"].includes(action)) {
    console.error("Usage: superagent deps check | superagent deps install [--yes]");
    return 2;
  }
  const report=checkNativeDependencies();
  console.log("[SuperAgent dependencies]");
  report.forEach(item => console.log(
    "  "+item.id+": "+(item.installed?"ready":"missing "+item.missing.join(", "))+" — "+item.requiredFor));
  if (action==="check") return report.every(item=>item.installed)?0:1;
  if (report.every(item=>item.installed)) return 0;
  const approved=args.includes("--yes");
  if (!approved && !process.stdin.isTTY) {
    console.error("Install requires an interactive confirmation or explicit '--yes'.");
    return 2;
  }
  let consent=approved;
  if (!approved) {
    const plan=nativeDependencyInstallPlan(process.platform,detectManagers());
    if (!plan) { console.error(dependencyInstallInstructions()); return 2; }
    console.log("Proposed: "+plan.label);
    const rl=createInterface({input:process.stdin,output:process.stdout});
    try { consent=/^(y|yes)$/i.test((await rl.question("Install with package manager? [y/N] ")).trim()); }
    finally { rl.close(); }
  }
  const result=await installNativeDependencies({approved:consent});
  console.log(result.message);
  return result.status==="already-installed"||result.status==="installed"?0:1;
}
