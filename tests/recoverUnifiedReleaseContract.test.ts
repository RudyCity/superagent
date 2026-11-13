import { describe,expect,it } from "vitest";
import fs from "node:fs";
import YAML from "yaml";

const text=fs.readFileSync(".github/workflows/recover-unified-release.yml","utf8");
const workflow=YAML.parse(text);
const steps=workflow.jobs.recover.steps;
const provenance=steps.find((x:any)=>x.name?.startsWith("Validate original"))?.run||"";
const verify=steps.find((x:any)=>x.name?.startsWith("Verify original"))?.run||"";
const publish=steps.find((x:any)=>x.name?.startsWith("Publish complete"))?.run||"";
describe("Recover unified release from immutable verified CI assets",()=>{
  it("is explicit manual dispatch and scoped to original repository assets",()=>{
    expect(workflow.on.workflow_dispatch.inputs.source_run_id.required).toBe(true);
    expect(workflow.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(workflow.permissions).toEqual({actions:"read",contents:"write"});
    const download=steps.find((x:any)=>x.uses==="actions/download-artifact@v4");
    expect(download.with["run-id"]).toContain("source_run_id");
    expect(download.with["github-token"]).toContain("github.token");
    expect(download.with.pattern).toBe("release-*");
    expect(download.with["merge-multiple"]).toBe(true);
  });
  it("requires matching immutable tag SHA and all six successful platform jobs",()=>{
    for(const fragment of [
      "git rev-parse", "refs/tags/$TARGET_TAG", 'head_sha==$sha',
      'head_branch==$tag', '.conclusion=="failure"',
      ".github/workflows/release-windows-standalone.yml",
      "Build & test windows-x64", "Build & test macos-arm64",
      "Build & test linux-x64", "Build verified Chrome Delegate and SidePanel",
      "Build verified Android LAN preview APK (debug-signed)",
      "Build and verify Windows LAN receiver GUI preview",
      "Publish unified verified standalone and preview components",
    ])expect(provenance).toContain(fragment);
  });
  it("fails closed on mismatched or duplicate assets and checks all SHA-256 sums",()=>{
    expect(verify).toContain("normalize-unified-release-assets.mjs");
    expect(verify).toContain("verify-unified-release-assets.mjs");
    expect(verify).toContain("sha256sum --check");
    expect(verify).toContain("wc -l < SHA256SUMS.txt");
    expect(publish).toContain('gh release create "$TARGET_TAG"');
    expect(publish).toContain("--verify-tag --prerelease");
    expect(publish).toContain('"$asset_count" == "12"');
    expect(text).not.toContain("--force");
    expect(text).not.toContain("gh release delete");
  });
});
