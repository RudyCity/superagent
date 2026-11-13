import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import YAML from "yaml";

const workflowText = fs.readFileSync(".github/workflows/release-windows-standalone.yml", "utf8");
const workflow = YAML.parse(workflowText);
const verifier = fs.readFileSync("scripts/verify-unified-release-assets.mjs", "utf8");

describe("Unified 3-OS + Chrome + LAN preview release integrity", () => {
  it("waits for all independent platform and extension jobs to succeed", () => {
    expect(workflow.jobs.build.strategy.matrix.include.map((x: any)=>x.platform).sort())
      .toEqual(["linux-x64","macos-arm64","windows-x64"]);
    expect(workflow.jobs.publish.needs.sort()).toEqual([
      "build", "build-android", "build-extensions", "build-lan-windows",
    ]);
    expect(workflow.jobs.publish.permissions.contents).toBe("write");
    expect(workflow.jobs.publish.steps.find((s: any)=>s.name?.includes("Require exact"))?.run)
      .toContain("verify-unified-release-assets.mjs");
    expect(workflowText).toContain("--verify-tag --prerelease");
  });

  it("packages both Chrome extensions from tagged manifests and verifies receipts", () => {
    const job = workflow.jobs["build-extensions"];
    const commands = job.steps.map((s: any) => s.run ?? "").join("\n");
    for (const name of ["verify:extension-js","release-delegate.mjs","release-sidepanel.mjs",
      "verify-release-extensions.mjs","stage-release-extensions.mjs"]) {
      expect(commands).toContain(name);
    }
    expect(verifier).toContain("receipt.sha256===digest");
    expect(verifier).toContain("receipt.packagedFiles");
  });

  it("builds real debug-signed Android APK and separately verifies Windows LAN", () => {
    const android=workflow.jobs["build-android"].steps.map((s:any)=>s.run??"").join("\n");
    expect(android).toContain("gradlew --no-daemon :app:assembleDebug");
    expect(android).toContain('apksigner" verify --print-certs');
    expect(android).toContain("deviceTunnelApkDownload.test.ts");
    expect(android).toContain("deviceTunnelHttp.test.ts");
    expect(android).toContain("output-metadata.json");
    const windows=workflow.jobs["build-lan-windows"].steps.map((s:any)=>s.run??"").join("\n");
    expect(windows).toContain("build-lan-windows-gui.ts");
    expect(windows).toContain("verify-lan-gui-receiver.ts");
    expect(windows).not.toContain("tests/deviceTunnelHttp.test.ts");
    expect(workflowText).toContain("debug-signed");
    expect(workflowText).toContain("unsigned preview installer");
  });

  it("accepts exactly eleven version-pinned assets and rejects corrupt receipts", () => {
    const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"unified-release-positive-"));
    try {
      const version=JSON.parse(fs.readFileSync("package.json","utf8")).version;
      const lan=JSON.parse(fs.readFileSync("apps/superagent-lan-windows/src-tauri/tauri.conf.json","utf8")).version;
      const android=fs.readFileSync("apps/superagent-lan-android/app/build.gradle","utf8")
        .match(/versionName\s+'([^']+)'/)![1];
      const large=[
        `SuperAgent_${version}_x64-setup.exe`,`SuperAgent_${version}_aarch64.dmg`,
        `SuperAgent_${version}_amd64.deb`,`SuperAgent_${version}_amd64.AppImage`,
        `SuperAgent-LAN-Client-${lan}-Windows-x64-setup.exe`,
      ];
      for(const name of large){
        const fd=fs.openSync(path.join(tmp,name),"w");
        fs.ftruncateSync(fd,20_000_001);
        fs.closeSync(fd);
      }
      const apk=`SuperAgent-LAN-Android-${android}-debug.apk`;
      const fd=fs.openSync(path.join(tmp,apk),"w");
      fs.ftruncateSync(fd,1_000_001);
      fs.closeSync(fd);
      fs.writeFileSync(path.join(tmp,`SuperAgent-LAN-Android-${android}-metadata.json`),
        JSON.stringify({applicationId:"click.superagent.lanclient",variantName:"debug",
          elements:[{versionName:android}]}));
      for(const [kind,source,label] of [
        ["delegate","chrome-extension-delegate","SuperAgent Delegate (ChatGPT)"],
        ["sidepanel","chrome-extension","SuperAgent Chrome SidePanel"],
      ]){
        const manifest=JSON.parse(fs.readFileSync(path.join(source,"manifest.json"),"utf8"));
        const stem=`superagent-${kind}-${manifest.version}`;
        const zip=Buffer.alloc(1001,0x42);
        fs.writeFileSync(path.join(tmp,stem+".zip"),zip);
        fs.writeFileSync(path.join(tmp,stem+".receipt.json"),JSON.stringify({
          component:label,version:manifest.version,archive:stem+".zip",
          sha256:createHash("sha256").update(zip).digest("hex"),
          packagedFiles:{"manifest.json":"a","background.js":"b",
            "content.js":"c","popup.js":"d"},
        }));
      }
      const ok=spawnSync("node",["scripts/verify-unified-release-assets.mjs",tmp],
        {cwd:process.cwd(),encoding:"utf8",timeout:30000});
      expect(ok.status,ok.stderr).toBe(0);
      expect(ok.stdout).toContain("UNIFIED_RELEASE_INVENTORY_VERIFIED 11 assets");
      const delegate=JSON.parse(fs.readFileSync("chrome-extension-delegate/manifest.json","utf8"));
      const receipt=path.join(tmp,`superagent-delegate-${delegate.version}.receipt.json`);
      const record=JSON.parse(fs.readFileSync(receipt,"utf8"));
      record.sha256="f".repeat(64);
      fs.writeFileSync(receipt,JSON.stringify(record));
      const corrupted=spawnSync("node",["scripts/verify-unified-release-assets.mjs",tmp],
        {cwd:process.cwd(),encoding:"utf8",timeout:30000});
      expect(corrupted.status).not.toBe(0);
      expect(corrupted.stderr).toContain("extension release receipt mismatch");
    } finally {fs.rmSync(tmp,{recursive:true,force:true});}
  });

  it("rejects incomplete or surplus artifacts before creating release", () => {
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"unified-release-contract-"));
    try {
      const result=spawnSync("node",["scripts/verify-unified-release-assets.mjs",temp],{
        cwd:process.cwd(),encoding:"utf8",timeout:10000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("UNIFIED_RELEASE_INVALID");
      expect(verifier).toContain("JSON.stringify(actual)===JSON.stringify(expected)");
      expect(verifier).toContain("stat.isFile()&&!stat.isSymbolicLink()");
      expect(verifier).toContain("receipt.sha256===digest");
      expect(verifier).toContain("Android version mismatch");
      expect(workflow.jobs.publish.steps.find((s:any)=>s.name?.includes("Require exact"))?.run)
        .toContain('test "$(wc -l < SHA256SUMS.txt)" -eq 11');
    } finally { fs.rmSync(temp,{recursive:true,force:true}); }
  });
});
