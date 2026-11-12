import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/bun-runtime.yml", import.meta.url), "utf8");

describe("Ubuntu media/browser CI dependency bootstrap", () => {
  it("never installs the Ubuntu Chromium Snap transition package", () => {
    expect(workflow).not.toMatch(/apt-get install[^\n]*chromium(?:-browser)?/);
    expect(workflow).toContain("uses: browser-actions/setup-chrome@v2");
    expect(workflow).toContain("chrome-version: stable");
    expect(workflow).toContain("install-dependencies: true");
    expect(workflow).toContain("steps.chrome.outputs.chrome-path");
    expect(workflow).toContain("STUDIO_CHROMIUM_PATH=$CHROME_BINARY");
    expect(workflow).toContain("--headless --no-sandbox");
    expect(workflow).toContain("grep -qi '<html'");
  });

  it("installs a real FFmpeg runtime and fails if shared libraries are missing", () => {
    expect(workflow).toContain("sudo apt-get install -y -qq ffmpeg libblas3 ripgrep");
    expect(workflow).toContain("test -x /usr/bin/ffmpeg");
    expect(workflow).toContain("test -x /usr/bin/ffprobe");
    expect(workflow).toContain("ldd /usr/bin/ffmpeg");
    expect(workflow).toContain("FFmpeg has unresolved shared libraries");
    expect(workflow).toContain("ffmpeg-ci-smoke.mp4");
    expect(workflow).toContain("codec_name=h264");
    expect(workflow).toContain('echo \'/usr/bin\' >> "$GITHUB_PATH"');
    expect(workflow).not.toMatch(/apt-get install[^\n]*\|\| true/);
  });

  it("uses only Vitest options supported by the pinned version", () => {
    expect(workflow).toContain("bun --bun x vitest run --maxWorkers=2 --reporter=dot");
    expect(workflow).not.toContain("--poolOptions.");
  });
});
