import { DesktopUiError } from "../desktopUi/errors.js";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "../desktopUi/processRunner.js";
import type { ExactWindowIdentity } from "./types.js";

const PYTHON3 = "/usr/bin/python3";
const WINDOW_ACTION_SCRIPT = [
  "import json, os",
  'import gi',
  'gi.require_version("Atspi", "2.0")',
  'from gi.repository import Atspi',
  'p=json.loads(os.environ["SUPERAGENT_DESKTOP_APP_WINDOW"])',
  'pid=int(p["pid"])',
  'title=str(p["title"])',
  'expected="atspi:%s:%s" % (pid,title)',
  'if p["nativeId"]!=expected: raise RuntimeError("TARGET_NOT_FOUND: invalid AT-SPI native identity")',
  'd=Atspi.get_desktop(0)',
  'apps=[]',
  'for i in range(d.get_child_count()):',
  '  a=d.get_child_at_index(i)',
  '  try:',
  '    if int(a.get_process_id())==pid: apps.append(a)',
  '  except Exception: pass',
  'if len(apps)!=1: raise RuntimeError("TARGET_NOT_FOUND: ambiguous application PID")',
  'app=apps[0]',
  'matches=[]',
  'for i in range(app.get_child_count()):',
  '  node=app.get_child_at_index(i)',
  '  try:',
  '    if (node.get_role_name() or "") in ("frame","window","dialog") and (node.get_name() or "") == title:',
  '      rect=node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)',
  '      if rect.width>0 and rect.height>0: matches.append(node)',
  '  except Exception: pass',
  'if len(matches)!=1: raise RuntimeError("TARGET_NOT_FOUND: ambiguous or absent AT-SPI window")',
  'node=matches[0]',
  'kind=p["action"]',
  'if kind=="exists":',
  '  print(json.dumps({"exists":True}))',
  'elif kind=="focus":',
  '  component=node.get_component_iface()',
  '  if not component or not component.grab_focus():',
  '    raise RuntimeError("INPUT_UNAVAILABLE: AT-SPI window refused focus")',
  '  print(json.dumps({"focused":True}))',
  'elif kind=="close":',
  '  iface=node.get_action_iface()',
  '  if not iface: raise RuntimeError("INPUT_UNAVAILABLE: window has no accessibility close action")',
  '  found=[]',
  '  for idx in range(iface.get_n_actions()):',
  '    if (iface.get_name(idx) or "").strip().lower()=="close": found.append(idx)',
  '  if len(found)!=1 or not iface.do_action(found[0]):',
  '    raise RuntimeError("INPUT_UNAVAILABLE: no exact close action for selected window")',
  '  print(json.dumps({"closeRequested":True}))',
  'else: raise RuntimeError("INVALID_ACTION: unsupported AT-SPI window action")',
].join("\n");

export function createLinuxWindowLifecycle(options: {
  runner?: DesktopProcessRunner;
  sessionType?: string;
  isProcessAlive?: (pid: number) => boolean;
} = {}) {
  const runner = options.runner ?? createRestrictedProcessRunner([PYTHON3]);
  const sessionType = (options.sessionType ?? process.env.XDG_SESSION_TYPE ?? "").trim().toLowerCase();

  async function action(target: ExactWindowIdentity, action: "exists" | "focus" | "close") {
    if (sessionType !== "x11") {
      throw new DesktopUiError("OS_PERMISSION_REQUIRED", "AT-SPI lifecycle input is restricted to a confirmed X11 session.");
    }
    if (!Number.isSafeInteger(target.pid) || target.pid <= 0
        || typeof target.nativeId !== "string") {
      throw new DesktopUiError("INVALID_ACTION", "Exact AT-SPI pid/nativeId required.");
    }
    const prefix = "atspi:" + target.pid + ":";
    if (!target.nativeId.startsWith(prefix) || target.nativeId.length <= prefix.length
        || target.nativeId.length > 600) {
      throw new DesktopUiError("TARGET_NOT_FOUND", "Target native ID is not bound to its exact PID and title.");
    }
    const title = target.nativeId.slice(prefix.length);
    if (/[\u0000-\u001f\u007f]/.test(title)) {
      throw new DesktopUiError("INVALID_ACTION", "AT-SPI window title contains unsupported control characters.");
    }
    try {
      const response = await runner.run({
        executable: PYTHON3, args: ["-c", WINDOW_ACTION_SCRIPT],
        env: { SUPERAGENT_DESKTOP_APP_WINDOW: JSON.stringify({
          pid: target.pid, nativeId: target.nativeId, title, action,
        }) },
        timeoutMs: 8_000,
      });
      const parsed = JSON.parse(response.stdout);
      if (action === "focus" && parsed.focused !== true) throw new Error("FOCUS_FAILED");
      if (action === "close" && parsed.closeRequested !== true) throw new Error("CLOSE_FAILED");
      if (action === "exists" && parsed.exists !== true) throw new Error("EXISTS_FAILED");
      return parsed;
    } catch (error) {
      if (error instanceof DesktopUiError) throw error;
      throw new DesktopUiError("PROCESS_FAILED", "Linux window action could not verify exact target or OS permission.");
    }
  }

  const isProcessAlive = options.isProcessAlive ?? ((pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  });

  return {
    async focusExact(target: ExactWindowIdentity): Promise<{ focused: true }> {
      await action(target, "focus");
      return { focused: true };
    },
    async closeExact(target: ExactWindowIdentity): Promise<{ closeRequested: true }> {
      await action(target, "close");
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
