import { describe, expect, it } from "vitest";
import fs from "node:fs";

const yml = fs.readFileSync(".github/workflows/bun-runtime.yml", "utf8");

describe("Bun full-regression prerequisites on disposable Ubuntu runner", () => {
  it("builds a real Gradle APK instead of creating or skipping a fake APK", () => {
    expect(yml).toContain("uses: android-actions/setup-android@v3");
    expect(yml).toContain("uses: actions/setup-java@v4");
    expect(yml).toContain("bash ./gradlew --no-daemon :app:assembleDebug");
    expect(yml).toContain("app/build/outputs/apk/debug/app-debug.apk");
    expect(yml).toContain("output-metadata.json");
    expect(yml).toContain("ANDROID_APK_REAL_GRADLE_BUILD_OK");
    expect(yml).toContain('z=zipfile.ZipFile(p)');
    expect(yml).not.toContain("base64 --decode > app-debug.apk");
  });
  it("installs actual Python and Office media backends required by regression", () => {
    for (const required of [
      "actions/setup-python@v5", "python-version: '3.11'",
      "pikepdf", "pymupdf", "Pillow", "python-docx",
      "python-pptx", "openpyxl", "libreoffice-writer",
      "libreoffice-calc", "libreoffice-impress",
      "PDF_MEDIA_BACKENDS_OK", "SUPERAGENT_PDF_PYTHON_BIN",
    ]) expect(yml).toContain(required);
  });
  it("runs the Bun-native security suite in Bun and keeps it out of Vitest", () => {
    expect(yml).toContain("bun test tests/delegateMcpPrincipalBinding.test.ts");
    expect(yml).toContain("--exclude tests/delegateMcpPrincipalBinding.test.ts");
    expect(yml).not.toContain("--poolOptions.");
  });
});
