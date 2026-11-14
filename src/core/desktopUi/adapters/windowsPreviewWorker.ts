/**
 * Scoped local Windows preview: one fixed-script worker per consented session.
 * Every frame verifies HWND, PID/birth, title, bounds, DWM cloak and capture
 * affinity before and after PrintWindow. No screen-wide fallback or input.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { locateVerifiedWindowsWgcHelper, WGC_HELPER_BACKEND } from "./windowsWgcArtifact.js";
import { DesktopUiError } from "../errors.js";
import type { DesktopDiscoveredWindow, DesktopWindowCaptureSource, NativeCapture } from "../types.js";

const POWER_SHELL = path.win32.join(
  process.env.SystemRoot || process.env.windir || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);
const WORKER_SCRIPT = String.raw`
$ErrorActionPreference="Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NWindow {
 [StructLayout(LayoutKind.Sequential)] public struct RECT {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint desiredAccess);
 [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 public static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder name,uint size,out uint needed);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h,out uint a);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h,uint a,out int v,int s);
}
'@
if ([NWindow]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) {exit 2}
$t=ConvertFrom-Json $env:SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET
if (!$t -or $t.pid -le 0 -or $t.nativeId -notmatch '^[0-9]+$') {exit 2}
$h=[IntPtr]([long]::Parse([string]$t.nativeId))
$ownerPid=[int]$t.pid
try {$birth=([System.Diagnostics.Process]::GetProcessById($ownerPid)).StartTime.ToUniversalTime().Ticks} catch {exit 2}
function Verify {
 # A locked Windows session switches the input desktop from Default to
 # Winlogon; refuse to capture anything on an unexpected/unknown desktop.
 # UOI_NAME=2, DESKTOP_READOBJECTS=0x0001. Close the desktop handle always.
 $inputDesktop=[NWindow]::OpenInputDesktop(0,$false,1)
 if ($inputDesktop -eq [IntPtr]::Zero) {throw "interactive desktop unavailable"}
 try {
  $desktopName=New-Object System.Text.StringBuilder 128
  [uint32]$needed=0
  $read=[NWindow]::GetUserObjectInformation(
    $inputDesktop,2,$desktopName,[uint32]($desktopName.Capacity * 2),[ref]$needed)
  if (-not $read -or $desktopName.ToString() -cne "Default") {throw "desktop locked"}
 } finally {
  [void][NWindow]::CloseDesktop($inputDesktop)
 }
 if (-not [NWindow]::IsWindow($h) -or -not [NWindow]::IsWindowVisible($h) -or
     [NWindow]::IsIconic($h) -or
     [NWindow]::GetAncestor($h,2) -ne $h) {throw "missing"}
 [uint32]$actualPid=0
 [void][NWindow]::GetWindowThreadProcessId($h,[ref]$actualPid)
 if ($actualPid -ne $ownerPid) {throw "owner"}
 $class=New-Object System.Text.StringBuilder 256
 [void][NWindow]::GetClassName($h,$class,$class.Capacity)
 if ($class.ToString() -in @("Shell_TrayWnd","Progman","WorkerW")) {throw "system window"}
 $p=[System.Diagnostics.Process]::GetProcessById($ownerPid)
 if ($p.ProcessName -cne [string]$t.application -or
     $p.StartTime.ToUniversalTime().Ticks -ne $birth) {throw "reused"}
 [uint32]$affinity=0
 if (-not [NWindow]::GetWindowDisplayAffinity($h,[ref]$affinity) -or $affinity -ne 0) {throw "protected"}
 $cloak=0
 if ([NWindow]::DwmGetWindowAttribute($h,14,[ref]$cloak,4) -ne 0 -or $cloak -ne 0) {throw "cloaked"}
 $r=New-Object NWindow+RECT
 if (-not [NWindow]::GetWindowRect($h,[ref]$r)) {throw "bounds"}
 $w=$r.Right-$r.Left
 $ht=$r.Bottom-$r.Top
 if ($w -le 0 -or $ht -le 0 -or $w -gt 8192 -or $ht -gt 8192 -or
    ([long]$w*[long]$ht) -gt 16000000 -or
    $r.Left -ne $t.bounds.x -or $r.Top -ne $t.bounds.y -or
    $w -ne $t.bounds.width -or $ht -ne $t.bounds.height) {throw "changed"}
 $len=[NWindow]::GetWindowTextLength($h)
 if ($len -le 0) {throw "title"}
 $b=New-Object System.Text.StringBuilder ([Math]::Min(513,$len+1))
 [void][NWindow]::GetWindowText($h,$b,$b.Capacity)
 $title=[regex]::Replace($b.ToString(),'[\x00-\x1F\x7F]','')
 if ($title -cne [string]$t.title) {throw "title changed"}
 $dpi=[NWindow]::GetDpiForWindow($h)
 if ($dpi -le 0) {throw "dpi"}
 return [pscustomobject]@{
  pid=$ownerPid;nativeId=$h.ToInt64().ToString();title=$title;
  active=([NWindow]::GetForegroundWindow() -eq $h);
  scaleFactor=([double]$dpi/96);
  bounds=[pscustomobject]@{x=$r.Left;y=$r.Top;width=$w;height=$ht}
 }
}
try {[void](Verify)} catch {exit 2}
[Console]::Out.WriteLine('{"type":"ready"}');[Console]::Out.Flush()
while ($true) {
 $command=[Console]::In.ReadLine()
 if ($null -eq $command -or $command -eq "close") {break}
 if ($command -ne "capture") {break}
 try {
  $before=Verify
  $bmp=[System.Drawing.Bitmap]::new([int]$before.bounds.width,[int]$before.bounds.height,
     [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  $memory=[System.IO.MemoryStream]::new()
  $dc=[IntPtr]::Zero
  try {
   $dc=$g.GetHdc()
   if (-not [NWindow]::PrintWindow($h,$dc,2)) {throw "capture"}
   $g.ReleaseHdc($dc);$dc=[IntPtr]::Zero
   $g.Dispose()
   $bmp.Save($memory,[System.Drawing.Imaging.ImageFormat]::Png)
   if ($memory.Length -lt 24 -or $memory.Length -gt 8388608) {throw "too large"}
   $after=Verify
   if ($before.title -cne $after.title -or $before.nativeId -cne $after.nativeId) {throw "changed"}
   $data=[pscustomobject]@{type="frame";window=$after;png=[Convert]::ToBase64String($memory.ToArray())}
   [Console]::Out.WriteLine(($data|ConvertTo-Json -Depth 5 -Compress));[Console]::Out.Flush()
  } finally {
   if ($dc -ne [IntPtr]::Zero) {$g.ReleaseHdc($dc)}
   $g.Dispose();$bmp.Dispose();$memory.Dispose()
  }
 } catch {
  [Console]::Out.WriteLine('{"type":"denied"}');[Console]::Out.Flush()
  break
 }
}
`;
const MAX_TEXT = 12 * 1024 * 1024;


export async function openWindowsVerifiedCapture(target: DesktopDiscoveredWindow): Promise<DesktopWindowCaptureSource> {
  if (process.platform !== "win32" || !Number.isSafeInteger(target.pid) || target.pid <= 0 ||
      !/^[0-9]+$/.test(target.nativeId) || !target.title || !target.application ||
      !["x","y","width","height"].every(k =>
        Number.isSafeInteger(target.bounds[k as keyof typeof target.bounds]))) {
    throw new DesktopUiError("INVALID_ACTION", "Scoped native capture requires a verified Windows HWND.");
  }
  // WGC remains explicitly owner-opt-in until installed desktop approval
  // and lifecycle checks are certified. Never select a binary from UI input
  // or an arbitrary environment path; use only the fixed verified build.
  const requestWgc = process.env.SUPERAGENT_DESKTOP_LIVE_WGC === "1";
  const wgcBinary = requestWgc ? locateVerifiedWindowsWgcHelper() : null;
  if (requestWgc && !wgcBinary) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "WGC was requested but no verified native helper was bundled.");
  }
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET: JSON.stringify({
    pid:target.pid,nativeId:target.nativeId,title:target.title,
    application:target.application,bounds:target.bounds,
  }) };
  delete spawnEnv.SUPERAGENT_WGC_DIAG;
  const child = spawn(wgcBinary ?? POWER_SHELL, wgcBinary ? [] : [
    "-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",
    Buffer.from(WORKER_SCRIPT,"utf16le").toString("base64"),
  ], {
    shell:false,windowsHide:true,stdio:["pipe","pipe","pipe"],
    env:spawnEnv,
  });
  // Do not log native stderr, even on failure: it may expose process/window
  // metadata. Drain it to avoid blocking the worker's pipe.
  child.stderr?.resume();
  let alive = true;
  let output = "";
  const queued:string[] = [];
  let waiter: {
    resolve:(s:string)=>void;
    reject:(e:Error)=>void;
    timeout:ReturnType<typeof setTimeout>;
  }|null = null;
  let expiry:ReturnType<typeof setTimeout>|null = null;
  const failure = new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Native preview refused or stopped.");
  function close():void {
    if (!alive) return;
    alive = false;
    if (expiry) clearTimeout(expiry);
    child.kill();
    child.stdin.destroy();
    child.stdout.destroy();
    if (waiter) {
      const w=waiter;
      waiter=null;
      clearTimeout(w.timeout);
      w.reject(failure);
    }
    queued.length=0;
    output="";
  }
  child.stdout.on("data",(chunk:Buffer)=>{
    if (!alive) return;
    output+=chunk.toString("utf8");
    if (output.length>MAX_TEXT) {close();return;}
    while (true) {
      const end=output.indexOf("\n");
      if (end<0) break;
      const line=output.slice(0,end).trim();
      output=output.slice(end+1);
      if (waiter) {
        const w=waiter;
        waiter=null;
        clearTimeout(w.timeout);
        w.resolve(line);
      }
      else if (queued.length<2) queued.push(line);
      else {close();return;}
    }
  });
  child.on("error",close);
  child.on("exit",close);
  function readLine():Promise<string> {
    if (!alive) return Promise.reject(failure);
    if (queued.length) return Promise.resolve(queued.shift()!);
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(close,15_000);
      timeout.unref();
      waiter={resolve,reject,timeout};
    });
  }
  let ready:unknown;
  try {ready=JSON.parse(await readLine());}
  catch {close();throw failure;}
  if ((ready as {type?:string})?.type!=="ready") {close();throw failure;}
  expiry=setTimeout(close,5*60_000);
  expiry.unref();
  let busy=false;
  return {
    backend:wgcBinary ? WGC_HELPER_BACKEND : "win32-persistent-exact-hwnd",
    verifiedInsideCapture:true,
    async capture():Promise<NativeCapture> {
      if (!alive||busy) throw failure;
      busy=true;
      try {
        child.stdin.write("capture\n");
        const response=JSON.parse(await readLine());
        if (response?.type!=="frame" || typeof response.png!=="string" ||
            response.png.length<24 || response.png.length>11_200_000 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(response.png)) throw failure;
        const image=Buffer.from(response.png,"base64");
        if (image.length<24||image.length>8*1024*1024) throw failure;
        const current=response.window;
        if (!current||current.pid!==target.pid||current.nativeId!==target.nativeId||
            current.title!==target.title||!["x","y","width","height"].every(k=>
              current.bounds?.[k]===target.bounds[k as keyof typeof target.bounds])) throw failure;
        return {image,targetWindow:current,capturedAt:new Date().toISOString()};
      } catch {close();throw failure;}
      finally {busy=false;}
    },
    close,
  };
}
