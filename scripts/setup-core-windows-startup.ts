/**
 * Windows logon startup provisioning for Core Boot. DEFAULT IS PREVIEW.
 *
 * bun scripts/setup-core-windows-startup.ts --port 7888
 * bun scripts/setup-core-windows-startup.ts --port 7888 --apply
 *
 * --apply modifies the current user's Windows Task Scheduler, never starts
 * the task immediately. It will not overwrite an existing task or launcher.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createCoreWindowsStartupPlan } from "../src/core/runtime/coreWindowsStartup.js";
import { auditCoreColdStart } from "../src/core/runtime/coreColdStartAudit.js";
import { readListenerOwners } from "../src/core/runtime/coreMcpOwnershipAudit.js";
import { assessWindowsStartupRegistrationR5 } from "../src/core/runtime/coreWindowsStartupGuardR5.js";

const args = process.argv.slice(2);
const index = args.indexOf("--port");
const port = index < 0 ? 7888 : Number(args[index + 1]);
const modeIndex = args.indexOf("--client-mode");
const clientMode = modeIndex < 0 ? "tline" : args[modeIndex + 1];
const apply = args.includes("--apply");
const profileIndex=args.indexOf("--profile");
const profileInput=profileIndex<0?undefined:args[profileIndex+1];
if(profileIndex>=0&&(!profileInput||profileInput.startsWith("--")))
  throw new Error("--profile requires an absolute pre-existing isolated staging directory");
for (const value of args) {
  if (!["--port", "--client-mode", "--apply", "--profile", "7888", String(port),
    clientMode, profileInput].includes(value)) {
    throw new Error("Unknown option: " + value);
  }
}
if (clientMode !== "tline" && clientMode !== "chrome-extension") {
  throw new Error("Invalid client mode");
}
const bunExecutable = process.execPath;
const cliFile = path.resolve(import.meta.dir, "..", "dist", "cli.js");
if (!fs.existsSync(cliFile)) throw new Error("Run bun run build first; compiled Core CLI unavailable");
const userHome = process.env.USERPROFILE || os.homedir();
const legacyRoot=path.join(userHome,".superagent-r");
const stageRoot=path.join(userHome,".superagent-local-staging");
let stageProfile:string|undefined;
if(profileInput){
  if(!path.isAbsolute(profileInput))throw new Error("Isolated profile path must be absolute");
  const stageRootReal=fs.realpathSync(stageRoot);
  const resolved=path.resolve(profileInput);
  stageProfile=fs.realpathSync(resolved);
  const relative=path.relative(stageRootReal,stageProfile);
  if(relative===""||relative===".."||relative.startsWith(".."+path.sep)||
     path.isAbsolute(relative)||fs.lstatSync(resolved).isSymbolicLink()||
     !fs.lstatSync(stageProfile).isDirectory())
    throw new Error("Isolated profile must be an existing real child of the staging root");
}
const root=path.join(stageProfile??legacyRoot,"windows-startup");
const launcherFile = path.join(root, "core-boot-" + port + ".ps1");
const plan = createCoreWindowsStartupPlan({
  port, clientMode, bunExecutable, cliFile, launcherFile,
  isolatedStageProfile:stageProfile,
});
console.log(JSON.stringify({
  type: "core-windows-logon-startup",
  mode: apply ? "APPLY" : "PREVIEW_ONLY",
  taskName: plan.taskName, trigger: "current user logon",
  isolatedStageProfile:stageProfile??null,
  launcherFile: plan.launcherFile, cliFile, bunExecutable,
  registerCommand: plan.registerCommand,
  inspectCommand: plan.inspectCommand,
  removeCommand: plan.removeCommand,
  note: "Preview is safe, but task installation is staging-only. Existing Core checkpoint requires explicit owner review. This is not a Windows Service.",
}, null, 2));
if (!apply) process.exit(0);
if (process.platform !== "win32") throw new Error("Cannot install Windows task on non-Windows");
if(!stageProfile)throw new Error("R5 refuses legacy/production startup registration; --apply requires --profile pointing to an isolated staging child");
if([6789,7888,9877].includes(port))
  throw new Error("R5 refuses shared legacy listeners; use a new isolated staging port");
const ownerMap=readListenerOwners();
const inspectScript=[
  "$ErrorActionPreference='Stop'",
  "$existing=Get-ScheduledTask -TaskName "+JSON.stringify(plan.taskName)+" -ErrorAction SilentlyContinue",
  "if($null -eq $existing){[Console]::Write('ABSENT')}else{[Console]::Write('PRESENT')}",
].join(";");
const inspect=spawnSync("powershell.exe",[
  "-NoProfile","-NonInteractive","-Command",inspectScript,
],{encoding:"utf8",timeout:10000,windowsHide:true,maxBuffer:8192});
const taskStatus=inspect.status===0&&inspect.stdout?.trim()==="ABSENT"?false:
  inspect.status===0&&inspect.stdout?.trim()==="PRESENT"?true:null;
const previousProfile=process.env.SUPERAGENT_CONFIG_DIR;
let cold;
try{
  process.env.SUPERAGENT_CONFIG_DIR=stageProfile;
  cold=await auditCoreColdStart(port);
}finally{
  if(previousProfile===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=previousProfile;
}
const decision=assessWindowsStartupRegistrationR5({
  port,stageProfileVerified:true,ownerInventoryVerified:ownerMap!==null,
  listenerPid:ownerMap?.get(port)??null,
  scheduledTaskPresent:taskStatus,coldAssessment:cold.assessment,
});
if(decision.status!=="staging_registration_candidate")
  throw new Error("R5 staging registration refused: "+decision.blockers.join(", "));
console.log("R5 staging registration preflight passed; no services started.");

const stat = fs.existsSync(root) ? fs.lstatSync(root) : null;
if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Unsafe startup plan directory");
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
if (fs.existsSync(launcherFile)) throw new Error("Startup launcher already exists; no overwrite. Inspect before manual removal.");
const handle = fs.openSync(launcherFile, "wx", 0o600);
try {
  fs.writeFileSync(handle, plan.launcherContent);
  fs.fsyncSync(handle);
} finally { fs.closeSync(handle); }
// Recheck the kernel listener immediately before registration; a late owner
// appearance must not turn a safe preview into a persistent startup collision.
const finalOwners=readListenerOwners();
if(!finalOwners||finalOwners.has(port))
  throw new Error("R5 listener appeared or ownership became unverifiable before task registration");
const encoded = Buffer.from(plan.registerCommand, "utf16le").toString("base64");
const proc = spawnSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded,
], { encoding: "utf8", timeout: 20_000, windowsHide: true, maxBuffer: 12_000 });
if (proc.status !== 0) {
  throw new Error("Task registration failed without starting Core. " +
    "Launcher retained for inspection. " + (proc.stderr || "").slice(0, 400));
}
console.log("Windows per-user logon task registered (not started). Verify with: " + plan.inspectCommand);
