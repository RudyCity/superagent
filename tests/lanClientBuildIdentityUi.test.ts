import { describe, expect, it } from "vitest";
import fs from "node:fs";

const read = (file: string) => fs.readFileSync(file, "utf8");

describe("Visible LAN Client build identifiers", () => {
  it("shows Android installed version name and actual versionCode", () => {
    const activity = read("apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/MainActivity.java");
    const gradle = read("apps/superagent-lan-android/app/build.gradle");
    expect(activity).toContain("appBuildLabel()");
    expect(activity).toContain("info.versionName");
    expect(activity).toContain("info.getLongVersionCode()");
    const versionCode = gradle.match(/versionCode\s+(\d+)/)?.[1];
    const versionName = gradle.match(/versionName\s+'([^']+)'/)?.[1];
    expect(Number(versionCode)).toBeGreaterThan(0);
    expect(versionName).toMatch(/^[A-Za-z0-9][A-Za-z0-9._+-]+$/);
    // A source-only CI checkout may not have compiled an APK yet.
    const metadataPath = "apps/superagent-lan-android/app/build/outputs/apk/debug/output-metadata.json";
    if (fs.existsSync(metadataPath)) {
      const metadata: { elements: { versionCode: number; versionName: string }[] } =
        JSON.parse(read(metadataPath));
      expect(metadata.elements[0].versionCode).toBe(Number(versionCode));
      expect(metadata.elements[0].versionName).toBe(versionName);
    }
  });

  it("shows the Tray version plus a build stamped into the Windows binary", () => {
    const buildScript = read("apps/superagent-tray/src-tauri/build.rs");
    const native = read("apps/superagent-tray/src-tauri/src/main.rs");
    const ui = read("apps/superagent-tray/ui/app.js");
    const html = read("apps/superagent-tray/ui/index.html");
    expect(buildScript).toContain("SUPERAGENT_TRAY_BUILD_NUMBER");
    expect(buildScript).toContain("SOURCE_DATE_EPOCH");
    expect(native).toContain('env!("SUPERAGENT_TRAY_BUILD_NUMBER")');
    expect(native).toContain("get_tray_build_number,");
    expect(ui).toContain('invoke?.("get_tray_build_number")');
    expect(html).toContain('id="tray-version"');
    expect(html).toContain('id="tray-build-number"');
  });
});
