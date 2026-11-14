import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openFixedWindowPreviewWorker } from "../../src/core/desktopUi/adapters/scopedNativePreviewWorker.js";
import type { DesktopDiscoveredWindow } from "../../src/core/desktopUi/types.js";

const target: DesktopDiscoveredWindow = {
  pid: 34567, nativeId: "cg:145", title: "Fixture title",
  application: "Fixture App", active: true,
  bounds: { x: 100, y: 100, width: 320, height: 240 },
};

const fixture = String.raw`
const target = JSON.parse(process.env.SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET);
process.stdout.write('{"type":"ready"}\n');
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data",(chunk)=>{
  pending += chunk;
  for (;;) {
    const end = pending.indexOf("\n");
    if (end < 0) break;
    const line = pending.slice(0,end);
    pending = pending.slice(end+1);
    if(line === "close") process.exit(0);
    if(line !== "capture") process.exit(2);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+h4AAAAASUVORK5CYII=","base64");
    const window = {
      pid: target.pid, nativeId: target.nativeId, title: target.title,
      bounds: target.bounds, active: true,
    };
    if (process.env.SUPERAGENT_NATIVE_FIXTURE_MODE === "wrong-title") window.title = "another window";
    process.stdout.write(JSON.stringify({type:"frame",png:png.toString("base64"),window})+"\n");
  }
});
`;

describe("fixed macOS native preview worker protocol (host-independent process fixture)", () => {
  it("delivers bounded exact-target frames and revokes on close", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(),"superagent-scoped-native-"));
    const script = path.join(directory,"helper.cjs");
    await fs.writeFile(script,fixture);
    try {
      const source = await openFixedWindowPreviewWorker(
        process.execPath,target,"darwin-sck-exact-cgwindow",[script],
      );
      const first = await source.capture();
      expect(first.targetWindow.nativeId).toBe(target.nativeId);
      expect(first.image.subarray(0,8)).toEqual(
        Buffer.from([137,80,78,71,13,10,26,10]),
      );
      expect((await source.capture()).targetWindow.title).toBe(target.title);
      source.close();
      await expect(source.capture()).rejects.toThrow(/stopped/);
    } finally {
      await fs.rm(directory,{recursive:true,force:true});
    }
  });

  it("revokes when a helper reports a different window even if pixels are valid", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(),"superagent-scoped-native-"));
    const script = path.join(directory,"helper.cjs");
    const prior = process.env.SUPERAGENT_NATIVE_FIXTURE_MODE;
    await fs.writeFile(script,fixture);
    process.env.SUPERAGENT_NATIVE_FIXTURE_MODE="wrong-title";
    try {
      const source = await openFixedWindowPreviewWorker(
        process.execPath,target,"darwin-sck-exact-cgwindow",[script],
      );
      await expect(source.capture()).rejects.toThrow(/stopped/);
      await expect(source.capture()).rejects.toThrow(/stopped/);
    } finally {
      if(prior===undefined) delete process.env.SUPERAGENT_NATIVE_FIXTURE_MODE;
      else process.env.SUPERAGENT_NATIVE_FIXTURE_MODE=prior;
      await fs.rm(directory,{recursive:true,force:true});
    }
  });
});
