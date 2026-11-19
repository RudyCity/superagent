import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { parse } from "yaml";

const yml = fs.readFileSync(".github/workflows/bun-runtime.yml", "utf8");

describe("Bun full-regression prerequisites on disposable Ubuntu runner", () => {
  it("builds a real Gradle APK instead of creating or skipping a fake APK", () => {
    expect(yml).not.toContain("uses: android-actions/setup-android@v3");
    expect(yml).toContain('sdk_root="${ANDROID_HOME:-/usr/local/lib/android/sdk}"');
    expect(yml).toContain('find "$sdk_root/cmdline-tools"');
    expect(yml).toContain('license_status=${PIPESTATUS[1]}');
    expect(yml).toContain('"$sdkmanager_bin" --install');
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
  it("runs principal security tests with Vitest and includes them in the full regression", () => {
    const steps = parse(yml).jobs.regression.steps;
    const principal = steps.find((step: { name?: string }) => step.name === "Run authenticated principal security tests");
    const regression = steps.find((step: { name?: string }) => step.name === "Run vitest regression");
    expect(principal?.run).toMatch(/^bun --bun x vitest run tests\/delegateMcpPrincipalBinding\.test\.ts(?:\s|$)/);
    expect(regression?.run).toMatch(/^bun --bun x vitest run(?:\s|$)/);
    expect(regression?.run).not.toMatch(/--exclude|--testNamePattern|\s+tests\//);
    const source = fs.readFileSync("tests/delegateMcpPrincipalBinding.test.ts", "utf8");
    expect(source).toContain('from "vitest"');
    expect(source).not.toContain('from "bun:test"');
    expect(yml).not.toContain("--poolOptions.");
  });
});
