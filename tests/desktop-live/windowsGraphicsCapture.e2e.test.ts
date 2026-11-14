import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { encodeJpegPreview } from "../../src/core/desktopUi/livePreviewEncoding.js";
import { createWindowsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/windows.js";
import { NativeWindowPreviewManager } from "../../src/core/desktopUi/livePreview.js";
import { locateVerifiedWindowsWgcHelper, WGC_HELPER_BACKEND } from "../../src/core/desktopUi/adapters/windowsWgcArtifact.js";
import { listDiscoveredWindows } from "../../src/core/desktopUi/discovery.js";

const binary = process.env.SUPERAGENT_WGC_TEST_EXE;
const powershell = path.win32.join(
  process.env.SystemRoot || process.env.windir || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);
const form = String.raw`
$ErrorActionPreference="Stop"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$f=New-Object System.Windows.Forms.Form
$f.Text=$env:SUPERAGENT_WGC_TEST_TITLE
$f.Width=425
$f.Height=285
$f.StartPosition="Manual"
$f.Location=New-Object System.Drawing.Point(230,220)
$label=New-Object System.Windows.Forms.Label
$label.Text="SuperAgent WGC fixture (not a user window)"
$label.Location=New-Object System.Drawing.Point(20,30)
$label.Size=New-Object System.Drawing.Size(350,100)
$f.Controls.Add($label)
$timer=New-Object System.Windows.Forms.Timer
$timer.Interval=30000
$timer.Add_Tick({$f.Close()})
$timer.Start()
$f.Show()
if ($env:SUPERAGENT_WGC_MUTATE_FILE) {
 $changeTimer=New-Object System.Windows.Forms.Timer
 $changeTimer.Interval=100
 $changeTimer.Add_Tick({
  if (Test-Path -LiteralPath $env:SUPERAGENT_WGC_MUTATE_FILE) {
   if ($env:SUPERAGENT_WGC_MUTATE_EVENT -eq "rename") {
    $f.Text="Changed WGC window"
   } elseif ($env:SUPERAGENT_WGC_MUTATE_EVENT -eq "minimize") {
    $f.WindowState=[System.Windows.Forms.FormWindowState]::Minimized
   } elseif ($env:SUPERAGENT_WGC_MUTATE_EVENT -eq "close") {
    $f.Close()
   }
   $changeTimer.Stop()
  }
 })
 $changeTimer.Start()
}
[Console]::Out.WriteLine("READY|"+$PID+"|"+$f.Handle.ToInt64())
[Console]::Out.Flush()
[System.Windows.Forms.Application]::Run($f)
`;

function receiveLine(child: ReturnType<typeof spawn>, within=10000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer="";
    const timeout=setTimeout(()=>{cleanup();reject(Error("WGC protocol deadline exceeded"));},within);
    function cleanup() {
      clearTimeout(timeout);
      child.stdout?.off("data",onData);
      child.off("exit",onExit);
      child.off("error",onError);
    }
    function onData(chunk:Buffer) {
      buffer+=chunk.toString("utf8");
      const index=buffer.indexOf("\n");
      if(index!==-1) {cleanup();resolve(buffer.slice(0,index).trim());}
    }
    function onExit(code:number|null) {cleanup();reject(Error("WGC helper exited before response: "+code));}
    function onError(error:Error) {cleanup();reject(error);}
    child.stdout?.on("data",onData);
    child.on("exit",onExit);
    child.on("error",onError);
  });
}

describe.skipIf(process.platform!=="win32" || !binary)("opt-in Windows Graphics Capture native host",()=>{
  it("opens verified bundled WGC from the real Core preview manager",async()=>{
    const located=locateVerifiedWindowsWgcHelper();
    expect(located).toBeTruthy();
    const title="SuperAgent WGC Manager "+randomUUID();
    const fixture=execa(powershell,["-NoProfile","-NonInteractive","-STA","-EncodedCommand",
      Buffer.from(form,"utf16le").toString("base64")],{
      reject:false,buffer:false,windowsHide:false,env:{SUPERAGENT_WGC_TEST_TITLE:title},
    });
    const prior=process.env.SUPERAGENT_DESKTOP_LIVE_WGC;
    process.env.SUPERAGENT_DESKTOP_LIVE_WGC="1";
    try {
      const ready=await new Promise<{pid:number;nativeId:string}>((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Error("Fixture not ready")),15000);
        let lines="";
        fixture.stdout?.on("data",(chunk:Buffer)=>{
          lines+=chunk.toString("utf8");
          const match=lines.match(/READY\|(\d+)\|(\d+)/);
          if(match){clearTimeout(timeout);resolve({pid:+match[1],nativeId:match[2]});}
        });
      });
      const manager=new NativeWindowPreviewManager(()=>createWindowsDesktopUiAdapter());
      const discovered=(await manager.discover()).windows.find(w=>
        w.pid===ready.pid&&w.nativeId===ready.nativeId&&w.title===title);
      expect(discovered).toBeDefined();
      const session=await manager.start({
        pid:ready.pid,nativeId:ready.nativeId,consent:true,
        expectedTitle:discovered!.title,expectedApplication:discovered!.application,
        expectedBounds:discovered!.bounds,
      });
      expect(session.backend).toBe(WGC_HELPER_BACKEND);
      const frame=await manager.frame({token:session.token,codec:"jpeg",maxWidth:640,quality:65});
      expect(frame.unchanged).toBe(false);
      if(frame.unchanged!==false||frame.format!=="jpeg") throw Error("Expected WGC JPEG");
      expect(frame.jpeg.startsWith("/9j/")).toBe(true);
      await new Promise(resolve=>setTimeout(resolve,500));
      const unchanged=await manager.frame({
        token:session.token,codec:"jpeg",maxWidth:640,quality:65,knownHash:frame.hash,
      });
      expect(unchanged.unchanged).toBe(true);
      expect(manager.stop({token:session.token})).toEqual({stopped:true});
      await expect(manager.frame({token:session.token})).rejects.toThrow(/revoked/);
    } finally {
      if(prior===undefined) delete process.env.SUPERAGENT_DESKTOP_LIVE_WGC;
      else process.env.SUPERAGENT_DESKTOP_LIVE_WGC=prior;
      fixture.kill("SIGTERM");
      await Promise.race([fixture.then(()=>{},()=>{}),new Promise(r=>setTimeout(r,2500))]);
    }
  },45000);
  for (const mutation of ["rename","minimize","close"] as const) {
    it("revokes WGC after approved window "+mutation,async()=>{
      const dir=await mkdtemp(path.join(os.tmpdir(),"superagent-wgc-mutation-"));
      const flag=path.join(dir,"signal.txt");
      const title="SuperAgent WGC Revocation "+randomUUID();
      const fixture=execa(powershell,["-NoProfile","-NonInteractive","-STA","-EncodedCommand",
        Buffer.from(form,"utf16le").toString("base64")],{
        reject:false,buffer:false,windowsHide:false,
        env:{SUPERAGENT_WGC_TEST_TITLE:title,SUPERAGENT_WGC_MUTATE_FILE:flag,
          SUPERAGENT_WGC_MUTATE_EVENT:mutation},
      });
      const previous=process.env.SUPERAGENT_DESKTOP_LIVE_WGC;
      process.env.SUPERAGENT_DESKTOP_LIVE_WGC="1";
      try {
        const ready=await new Promise<{pid:number;nativeId:string}>((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(Error("Fixture not ready")),15000);
          let lines="";
          fixture.stdout?.on("data",(chunk:Buffer)=>{
            lines+=chunk.toString("utf8");
            const match=lines.match(/READY\|(\d+)\|(\d+)/);
            if(match){clearTimeout(timeout);resolve({pid:+match[1],nativeId:match[2]});}
          });
        });
        const manager=new NativeWindowPreviewManager(()=>createWindowsDesktopUiAdapter());
        const discovered=(await manager.discover()).windows.find(w=>
          w.pid===ready.pid&&w.nativeId===ready.nativeId&&w.title===title);
        expect(discovered).toBeDefined();
        const session=await manager.start({
          pid:ready.pid,nativeId:ready.nativeId,consent:true,
          expectedTitle:discovered!.title,expectedApplication:discovered!.application,
          expectedBounds:discovered!.bounds,
        });
        expect(session.backend).toBe(WGC_HELPER_BACKEND);
        const baseline=await manager.frame({token:session.token,codec:"jpeg",maxWidth:640,quality:65});
        expect(baseline.unchanged).toBe(false);
        await writeFile(flag,mutation,"utf8");
        await new Promise(resolve=>setTimeout(resolve,500));
        await expect(manager.frame({token:session.token,codec:"jpeg",maxWidth:640,quality:65,
          knownHash:baseline.hash})).rejects.toThrow(/stopped/);
        await expect(manager.frame({token:session.token})).rejects.toThrow(/revoked/);
      } finally {
        if(previous===undefined) delete process.env.SUPERAGENT_DESKTOP_LIVE_WGC;
        else process.env.SUPERAGENT_DESKTOP_LIVE_WGC=previous;
        fixture.kill("SIGTERM");
        await Promise.race([fixture.then(()=>{},()=>{}),new Promise(r=>setTimeout(r,2500))]);
        await rm(dir,{recursive:true,force:true});
      }
    },45000);
  }

  it("captures exactly one disposable form via approved HWND, no desktop-wide fallback",async()=>{
    await access(binary!);
    const title="SuperAgent WGC Host "+randomUUID();
    const fixture=execa(powershell,["-NoProfile","-NonInteractive","-STA","-EncodedCommand",
      Buffer.from(form,"utf16le").toString("base64")],{
      reject:false,buffer:false,windowsHide:false,env:{SUPERAGENT_WGC_TEST_TITLE:title},
    });
    let helper:ReturnType<typeof spawn>|undefined;
    try {
      const ready = await new Promise<{pid:number; nativeId:string}>((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Error("No fixture form")),15000);
        let text="";
        fixture.stdout?.on("data",(chunk:Buffer)=>{
          text+=chunk.toString();
          const match=text.match(/READY\|(\d+)\|(\d+)/);
          if(match){clearTimeout(timeout);resolve({pid:+match[1],nativeId:match[2]});}
        });
      });
      const adapter=createWindowsDesktopUiAdapter();
      const found=(await listDiscoveredWindows(adapter,100)).windows.find(w=>
        w.pid===ready.pid && w.nativeId===ready.nativeId && w.title===title);
      expect(found).toBeDefined();
      helper=spawn(binary!,[],{
        shell:false, windowsHide:true, stdio:["pipe","pipe","pipe"],
        env:{...process.env,SUPERAGENT_WGC_DIAG:"1",SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET:JSON.stringify({
          pid:found!.pid,nativeId:found!.nativeId,title:found!.title,
          application:found!.application,bounds:found!.bounds,
        })},
      });
      let stderrText="";
helper.stderr?.on("data",(chunk:Buffer)=>{stderrText+=chunk.toString("utf8").slice(0,1200);});
const readyMessage=JSON.parse(await receiveLine(helper,12000).catch(error=>{
  throw Error(String(error)+" "+stderrText);
}));
      expect(readyMessage.type).toBe("ready");
      helper.stdin?.write("capture\n");
      const response=JSON.parse(await receiveLine(helper,10000));
      expect(response.type).toBe("frame");
      expect(response.window.pid).toBe(found!.pid);
      expect(response.window.nativeId).toBe(found!.nativeId);
      expect(response.window.title).toBe(found!.title);
      const png=Buffer.from(response.png,"base64");
      expect(png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
      expect(png.length).toBeGreaterThan(500);
      const encoded=await encodeJpegPreview(png,{maxWidth:640,quality:65});
      expect(encoded.format).toBe("jpeg");
      for (let i=0;i<6;i++) {
        helper.stdin?.write("capture\n");
        const repeat=JSON.parse(await receiveLine(helper,6000));
        expect(repeat.type).toBe("frame");
        expect(repeat.window.pid).toBe(found!.pid);
        expect(repeat.window.nativeId).toBe(found!.nativeId);
        expect(Buffer.from(repeat.png,"base64").subarray(0,8))
          .toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
      }
      helper.stdin?.write("close\n");
    } finally {
      helper?.kill();
      fixture.kill("SIGTERM");
      await Promise.race([fixture.then(()=>{},()=>{}),new Promise(r=>setTimeout(r,2500))]);
      if(!fixture.killed) fixture.kill("SIGKILL");
    }
  },45000);
});
