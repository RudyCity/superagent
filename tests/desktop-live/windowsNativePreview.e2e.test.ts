import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { NativeWindowPreviewManager } from "../../src/core/desktopUi/livePreview.js";
import { createWindowsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/windows.js";

const powershell = path.win32.join(
  process.env.SystemRoot || process.env.windir || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);
const fixtureScript = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:SUPERAGENT_PREVIEW_TEST_TITLE
$form.Width = 420
$form.Height = 290
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point(180,180)
$label = New-Object System.Windows.Forms.Label
$label.Text = "Only this disposable window is authorized"
$label.Location = New-Object System.Drawing.Point(30,30)
$label.Size = New-Object System.Drawing.Size(340,80)
$form.Controls.Add($label)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
$form.Show()
if ($env:SUPERAGENT_PREVIEW_TEST_MINIMIZE_FILE) {
 $minimizeTimer = New-Object System.Windows.Forms.Timer
 $minimizeTimer.Interval = 100
 $minimizeTimer.Add_Tick({
  if (Test-Path -LiteralPath $env:SUPERAGENT_PREVIEW_TEST_MINIMIZE_FILE) {
   $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
   $minimizeTimer.Stop()
  }
 })
 $minimizeTimer.Start()
}
if ($env:SUPERAGENT_PREVIEW_TEST_CLOSE_FILE) {
 $closeTimer = New-Object System.Windows.Forms.Timer
 $closeTimer.Interval = 100
 $closeTimer.Add_Tick({
  if (Test-Path -LiteralPath $env:SUPERAGENT_PREVIEW_TEST_CLOSE_FILE) {
   $form.Close()
   $closeTimer.Stop()
  }
 })
 $closeTimer.Start()
}
if ($env:SUPERAGENT_PREVIEW_TEST_RENAME_FILE) {
 $renameTimer = New-Object System.Windows.Forms.Timer
 $renameTimer.Interval = 100
 $renameTimer.Add_Tick({
  if (Test-Path -LiteralPath $env:SUPERAGENT_PREVIEW_TEST_RENAME_FILE) {
   $form.Text = "Changed private window"
   $renameTimer.Stop()
  }
 })
 $renameTimer.Start()
}
[Console]::Out.WriteLine("READY|" + $PID + "|" + $form.Handle.ToInt64())
[Console]::Out.Flush()
[System.Windows.Forms.Application]::Run($form)
`;
function waitReady(child: ReturnType<typeof execa>): Promise<{pid:number;nativeId:string}> {
  return new Promise((resolve,reject) => {
    let buffer = "";
    const timer = setTimeout(()=>reject(Error("Disposable native fixture not ready")),12000);
    const finish = (result?:{pid:number;nativeId:string}, err?:Error) => {
      clearTimeout(timer);
      child.stdout?.off("data",onData);
      child.off("error",onError);
      if (err) reject(err);
      else if(result) resolve(result);
    };
    const onError = (err:Error) => finish(undefined,err);
    const onData = (data:Buffer) => {
      buffer += data.toString();
      const match = buffer.match(/READY\|(\d+)\|(\d+)/);
      if(match) finish({pid:Number(match[1]),nativeId:match[2]});
    };
    child.stdout?.on("data",onData);
    child.on("error",onError);
  });
}
async function terminate(child: ReturnType<typeof execa>): Promise<void> {
  child.kill("SIGTERM");
  const ended = await Promise.race([child.then(()=>true,()=>true),Bun.sleep(2500).then(()=>false)]);
  if (!ended) child.kill("SIGKILL");
}
describe.skipIf(process.platform !== "win32")("Windows real native private-window capture", () => {
  it("streams exactly the disposable WinForms window without enabling OS input", async () => {
    const title = "SuperAgent Private Window Fixture " + randomUUID();
    const encoded = Buffer.from(fixtureScript,"utf16le").toString("base64");
    const child = execa(powershell,["-NoProfile","-NonInteractive","-STA","-EncodedCommand",encoded],{
      reject:false, buffer:false,windowsHide:false,
      env:{SUPERAGENT_PREVIEW_TEST_TITLE:title},
    });
    try {
      const fixture = await waitReady(child);
      const manager = new NativeWindowPreviewManager(()=>createWindowsDesktopUiAdapter());
      const listed = await manager.discover();
      expect(listed.windows.some(w=>w.pid===fixture.pid && w.nativeId===fixture.nativeId && w.title===title)).toBe(true);
      const selected = listed.windows.find(w => w.pid === fixture.pid && w.nativeId === fixture.nativeId)!;
      const started = await manager.start({
        pid:fixture.pid,nativeId:fixture.nativeId,consent:true,
        expectedTitle:selected.title,expectedApplication:selected.application,
        expectedBounds:selected.bounds,
      });
      expect(started.window.title).toBe(title);
      const frame = await manager.frame({token:started.token});
      expect(frame.format).toBe("png");
      const png = Buffer.from(frame.png,"base64");
      expect(png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
      expect(png.byteLength).toBeGreaterThan(1024);
      await Bun.sleep(650);
      const compressed = await manager.frame({
        token: started.token, codec: "jpeg", maxWidth: 1024, quality: 65,
        knownHash: frame.hash,
      });
      // PNG and JPEG differ even when sourced from identical pixels.
      expect(compressed.unchanged).toBe(false);
      if (compressed.unchanged !== false || compressed.format !== "jpeg") {
        throw Error("Expected verified native JPEG frame");
      }
      expect(compressed.width).toBeLessThanOrEqual(1024);
      expect(Buffer.from(compressed.jpeg, "base64").subarray(0,3))
        .toEqual(Buffer.from([255,216,255]));
      await Bun.sleep(650);
      const reusedJpeg = await manager.frame({
        token: started.token, codec: "jpeg", maxWidth: 1024, quality: 65,
        knownHash: compressed.hash,
      });
      expect(reusedJpeg.unchanged).toBe(true);
      expect(reusedJpeg).not.toHaveProperty("jpeg");
      expect(manager.stop({token:started.token})).toEqual({stopped:true});
      await expect(manager.frame({token:started.token})).rejects.toThrow(/revoked/);
    } finally {
      await terminate(child);
    }
  },45000);

  it("reuses one verified Windows source across consecutive bounded frames and revokes its token", async () => {
    const title = "SuperAgent Native Preview Soak " + randomUUID();
    const encoded = Buffer.from(fixtureScript, "utf16le").toString("base64");
    const child = execa(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], {
      reject: false, buffer: false, windowsHide: false,
      env: { SUPERAGENT_PREVIEW_TEST_TITLE: title },
    });
    try {
      const fixture = await waitReady(child);
      const manager = new NativeWindowPreviewManager(() => createWindowsDesktopUiAdapter());
      const selected = (await manager.discover()).windows.find(
        w => w.pid === fixture.pid && w.nativeId === fixture.nativeId,
      );
      expect(selected).toBeDefined();
      const approval = {
        pid: fixture.pid, nativeId: fixture.nativeId, consent: true,
        expectedTitle: selected!.title, expectedApplication: selected!.application,
        expectedBounds: selected!.bounds,
      };
      const session = await manager.start(approval);
      expect(session.backend).toBe("win32-persistent-exact-hwnd");
      let previousHash: string | undefined;
      let skipped = 0;
      for (let i = 0; i < 10; i++) {
        const frame = await manager.frame({
          token: session.token, codec: "jpeg", maxWidth: 768, quality: 50,
          ...(previousHash ? { knownHash: previousHash } : {}),
        });
        expect(frame.hash).toMatch(/^[a-f0-9]{64}$/);
        if (frame.unchanged) {
          skipped += 1;
          expect(frame).not.toHaveProperty("jpeg");
        } else {
          if (frame.format !== "jpeg") throw Error("Expected bounded JPEG from native window");
          expect(Buffer.from(frame.jpeg, "base64").length).toBeLessThanOrEqual(512 * 1024);
        }
        previousHash = frame.hash;
        if (i < 9) await Bun.sleep(300);
      }
      expect(skipped).toBeGreaterThan(0);
      expect(manager.stop({ token: session.token })).toEqual({ stopped: true });
      await expect(manager.frame({ token: session.token })).rejects.toThrow(/revoked/);
      const next = await manager.start(approval);
      expect(next.token).not.toBe(session.token);
      expect(manager.stop({ token: next.token })).toEqual({ stopped: true });
    } finally {
      await terminate(child);
    }
  }, 45000);

  it("revokes native frames when the approved window changes title", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(),"superagent-preview-renamed-"));
    const signal = path.join(dir,"rename.txt");
    const title = "SuperAgent Native Identity " + randomUUID();
    const encoded = Buffer.from(fixtureScript,"utf16le").toString("base64");
    const child = execa(powershell,["-NoProfile","-NonInteractive","-STA","-EncodedCommand",encoded],{
      reject:false,buffer:false,windowsHide:false,
      env:{SUPERAGENT_PREVIEW_TEST_TITLE:title,SUPERAGENT_PREVIEW_TEST_RENAME_FILE:signal},
    });
    try {
      const {pid,nativeId} = await waitReady(child);
      const manager = new NativeWindowPreviewManager(()=>createWindowsDesktopUiAdapter());
      const found = (await manager.discover()).windows.find(w=>w.pid===pid && w.nativeId===nativeId);
      expect(found).toBeDefined();
      const {token,backend} = await manager.start({
        pid,nativeId,consent:true,
        expectedTitle:found!.title,expectedApplication:found!.application,
        expectedBounds:found!.bounds,
      });
      expect(backend).toBe("win32-persistent-exact-hwnd");
      await writeFile(signal,"rename","utf8");
      await Bun.sleep(450);
      await expect(manager.frame({token,codec:"jpeg",maxWidth:640,quality:65})).rejects.toThrow(/stopped/);
      await expect(manager.frame({token})).rejects.toThrow(/revoked/);
    } finally {
      await terminate(child);
      await rm(dir,{recursive:true,force:true});
    }
  },45000);

  for (const event of ["minimize","close"] as const) {
    it("revokes native preview when the approved window is " + event, async () => {
      const dir=await mkdtemp(path.join(os.tmpdir(),"superagent-preview-lifecycle-"));
      const signal=path.join(dir,"signal.txt");
      const title="SuperAgent Window Lifecycle "+randomUUID();
      const encoded=Buffer.from(fixtureScript,"utf16le").toString("base64");
      const child=execa(powershell,["-NoProfile","-NonInteractive","-STA","-EncodedCommand",encoded],{
        reject:false,buffer:false,windowsHide:false,
        env:{
          SUPERAGENT_PREVIEW_TEST_TITLE:title,
          ...(event==="minimize" ? {SUPERAGENT_PREVIEW_TEST_MINIMIZE_FILE:signal} :
            {SUPERAGENT_PREVIEW_TEST_CLOSE_FILE:signal}),
        },
      });
      try {
        const {pid,nativeId}=await waitReady(child);
        const manager=new NativeWindowPreviewManager(()=>createWindowsDesktopUiAdapter());
        const found=(await manager.discover()).windows.find(w=>w.pid===pid && w.nativeId===nativeId);
        expect(found).toBeDefined();
        const session=await manager.start({
          pid,nativeId,consent:true,expectedTitle:found!.title,
          expectedApplication:found!.application,expectedBounds:found!.bounds,
        });
        await writeFile(signal,event,"utf8");
        await Bun.sleep(500);
        await expect(manager.frame({token:session.token,codec:"jpeg",maxWidth:640,quality:65}))
          .rejects.toThrow(/stopped/);
        await expect(manager.frame({token:session.token})).rejects.toThrow(/revoked/);
      } finally {
        await terminate(child);
        await rm(dir,{recursive:true,force:true});
      }
    },45000);
  }
});
