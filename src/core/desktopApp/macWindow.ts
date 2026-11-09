import { DesktopUiError } from "../desktopUi/errors.js";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "../desktopUi/processRunner.js";
import type { ExactWindowIdentity } from "./types.js";

const OSASCRIPT = "/usr/bin/osascript";
const WINDOW_ACTION_SCRIPT = [
  'ObjC.import("stdlib");',
  'ObjC.import("CoreGraphics");',
  'const p=JSON.parse(ObjC.unwrap($.getenv("SUPERAGENT_DESKTOP_APP_WINDOW")));',
  'const se=Application("System Events");',
  'if (!Boolean(se.UIElementsEnabled())) throw new Error("OS_PERMISSION_REQUIRED: Accessibility permission required");',
  'const processes=se.applicationProcesses().filter((proc) => {',
  '  try {return Number(proc.unixId())===Number(p.pid);}catch(_){return false;}',
  '});',
  'if(processes.length!==1) throw new Error("TARGET_NOT_FOUND: PID ambiguous or absent");',
  'const proc=processes[0];',
  'const infos=ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(',
  '  Number($.kCGWindowListOptionAll) | Number($.kCGWindowListExcludeDesktopElements),',
  '  Number($.kCGNullWindowID)));',
  'if(!Array.isArray(infos)) throw new Error("OS_PERMISSION_REQUIRED: CGWindow enumeration failed");',
  'const cg=infos.filter((info) => Number(info.kCGWindowNumber)===Number(p.windowNumber)',
  '  && Number(info.kCGWindowOwnerPID)===Number(p.pid)',
  '  && Number(info.kCGWindowLayer||0)===0);',
  'if(cg.length!==1) throw new Error("TARGET_NOT_FOUND: exact CG window absent or ambiguous");',
  'const b=cg[0].kCGWindowBounds||{};',
  'const near=(a,b)=>Number.isFinite(Number(a)) && Math.abs(Number(a)-Number(b))<=1;',
  'const matching=[];',
  'for(const win of proc.windows()){',
  '  try {',
  '    const pos=win.position(),sz=win.size();',
  '    if(!near(pos[0],b.X)||!near(pos[1],b.Y)||!near(sz[0],b.Width)||!near(sz[1],b.Height))continue;',
  '    matching.push(win);',
  '  } catch(_){}',
  '}',
  'if(matching.length!==1) throw new Error("TARGET_NOT_FOUND: CG-to-AX window identity ambiguous");',
  'const win=matching[0];',
  'let receipt=null;',
  'if(p.action==="exists"){ receipt={exists:true}; }',
  'else if(p.action==="focus"){',
  '  const raises=win.actions().filter(a=>{try{return String(a.name())==="AXRaise";}catch(_){return false;}});',
  '  if(raises.length!==1) throw new Error("INPUT_UNAVAILABLE: exact AXRaise action unavailable");',
  '  raises[0].perform();',
  '  if(!Boolean(proc.frontmost())||!Boolean(win.focused()))throw new Error("TARGET_NOT_ACTIVE: AXRaise could not prove focus");',
  '  receipt={focused:true};',
  '} else if(p.action==="close"){',
  '  const closeButtons=win.buttons().filter(btn=>{',
  '    try{return String(btn.subrole())==="AXCloseButton";}catch(_){return false;}',
  '  });',
  '  if(closeButtons.length!==1)throw new Error("INPUT_UNAVAILABLE: exact AXCloseButton unavailable");',
  '  closeButtons[0].click();',
  '  receipt={closeRequested:true};',
  '} else throw new Error("INVALID_ACTION: unsupported window lifecycle action");',
  'JSON.stringify(receipt);',
].join("\n");

export function createMacWindowLifecycle(options: { runner?: DesktopProcessRunner; isProcessAlive?: (pid: number) => boolean } = {}) {
  const runner = options.runner ?? createRestrictedProcessRunner([OSASCRIPT]);

  async function run(target: ExactWindowIdentity, action: "exists" | "focus" | "close") {
    if (!Number.isSafeInteger(target.pid) || target.pid <= 0) {
      throw new DesktopUiError("INVALID_ACTION", "Exact macOS PID required.");
    }
    const match = /^cg:([1-9]\d{0,14})$/.exec(target.nativeId);
    const windowNumber = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(windowNumber) || windowNumber <= 0) {
      throw new DesktopUiError("INVALID_ACTION", "Exact CGWindowNumber nativeId required.");
    }
    try {
      const result = await runner.run({
        executable: OSASCRIPT,
        args: ["-l", "JavaScript", "-e", WINDOW_ACTION_SCRIPT],
        env: { SUPERAGENT_DESKTOP_APP_WINDOW: JSON.stringify({
          pid: target.pid, windowNumber, action,
        }) },
        timeoutMs: 8_000,
      });
      const payload = JSON.parse(result.stdout);
      if ((action === "exists" && payload.exists !== true)
          || (action === "focus" && payload.focused !== true)
          || (action === "close" && payload.closeRequested !== true)) {
        throw new Error("Lifecycle action did not confirm success.");
      }
    } catch (error) {
      if (error instanceof DesktopUiError) throw error;
      throw new DesktopUiError("PROCESS_FAILED", "macOS window action failed to verify exact CG/AX target.");
    }
  }

  const isProcessAlive = options.isProcessAlive ?? ((pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  });

  return {
    async focusExact(target: ExactWindowIdentity): Promise<{ focused: true }> {
      await run(target, "focus");
      return { focused: true };
    },
    async closeExact(target: ExactWindowIdentity): Promise<{ closeRequested: true }> {
      await run(target, "close");
      return { closeRequested: true };
    },
    async waitUntilClosed(target: ExactWindowIdentity, timeoutMs: number): Promise<boolean> {
      if (!Number.isSafeInteger(target.pid) || target.pid <= 0) return false;
      const deadline = Date.now() + Math.min(Math.max(timeoutMs, 100), 5_000);
      while (Date.now() < deadline) {
        if (!isProcessAlive(target.pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return false;
    },
  };
}
