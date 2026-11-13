import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
