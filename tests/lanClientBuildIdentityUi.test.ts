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
    expect(gradle).toContain("versionCode 11");
    expect(gradle).toContain("versionName '0.7.4-ephemeral-tls-preview'");
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
