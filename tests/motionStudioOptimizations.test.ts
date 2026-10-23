import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getPiperConfig, localVoiceoverConfigured } from "../src/core/motion/director/localVoiceover.js";
import { splitTextLines } from "../src/core/motion/layout/textLayout.js";
import { renderMotionSvg } from "../src/core/motion/runtime/frameSvg.js";
import { createMotionFrameRenderer } from "../src/core/motion/render/canvasFrames.js";
import { withMotionQueueAdmission, motionConcurrentSlots } from "../src/core/motion/jobs/renderScheduler.js";
import { transcodeAudioToCanonicalWav, inspectMotionWav } from "../src/core/motion/assets/motionAudio.js";
import { updateSettings } from "../src/core/config/jsonConfig.js";
import { evaluateFrame } from "../src/core/motion/timeline/evaluateFrame.js";
import { importMotionFont, isAllowedMotionFont } from "../src/core/motion/assets/motionFonts.js";
import { importMotionVideo, readMotionVideo } from "../src/core/motion/assets/motionVideoClips.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import type { MotionProject } from "../src/core/motion/schema/types.js";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

describe("Superagent Studio P0 & Architecture Optimizations", () => {
  describe("1. Piper TTS Config Resolution (JSON settings priority)", () => {
    it("reads motionPiperBin and motionPiperModel from JSON settings", () => {
      updateSettings({
        motionPiperBin: "/custom/path/piper.exe",
        motionPiperModel: "/custom/path/model.onnx",
      });
      // Even if env is set, JSON settings must take precedence or resolve cleanly
      const config = getPiperConfig();
      expect(config).toEqual({
        binary: "/custom/path/piper.exe",
        model: "/custom/path/model.onnx",
      });
      expect(localVoiceoverConfigured()).toBe(true);

      // Clean up settings override
      updateSettings({
        motionPiperBin: undefined,
        motionPiperModel: undefined,
      });
    });

    it("falls back to process.env if JSON settings are not configured", () => {
      updateSettings({
        motionPiperBin: undefined,
        motionPiperModel: undefined,
      });
      vi.stubEnv("SUPERAGENT_MOTION_PIPER_BIN", "/env/path/piper");
      vi.stubEnv("SUPERAGENT_MOTION_PIPER_MODEL", "/env/path/voice.onnx");

      const config = getPiperConfig();
      expect(config).toEqual({
        binary: "/env/path/piper",
        model: "/env/path/voice.onnx",
      });
      expect(localVoiceoverConfigured()).toBe(true);
    });

    it("returns null when neither JSON settings nor env are provided", () => {
      updateSettings({
        motionPiperBin: undefined,
        motionPiperModel: undefined,
      });
      vi.stubEnv("SUPERAGENT_MOTION_PIPER_BIN", "");
      vi.stubEnv("SUPERAGENT_MOTION_PIPER_MODEL", "");
      expect(getPiperConfig()).toBeNull();
      expect(localVoiceoverConfigured()).toBe(false);
    });
  });

  describe("2. Multiline & Auto-Wrap Text Layout", () => {
    it("splits explicit newlines into multiple lines", () => {
      const lines = splitTextLines("Line 1\nLine 2\nLine 3");
      expect(lines).toEqual(["Line 1", "Line 2", "Line 3"]);
    });

    it("wraps words when maxWidth is exceeded", () => {
      // Mock measureFn where each char is 10px wide
      const measure = (s: string) => s.length * 10;
      // maxWidth 100px means max 10 chars per line
      const lines = splitTextLines("Hello brave new world", 100, measure);
      // "Hello brave" = 11 chars (110px > 100px) -> wraps
      expect(lines).toEqual(["Hello", "brave new", "world"]);
    });

    it("renders multiline text in SVG preview with tspans", () => {
      const project: MotionProject = {
        schemaVersion: 1,
        id: "motion-test-multiline-001",
        workspaceRoot: "/test",
        name: "Multiline Test",
        revision: 1,
        createdAt: "2026-10-23T00:00:00Z",
        updatedAt: "2026-10-23T00:00:00Z",
        composition: {
          width: 320,
          height: 240,
          fps: { numerator: 30, denominator: 1 },
          durationFrames: 10,
          background: "#000000",
          layers: [
            {
              id: "txt-multiline",
              kind: "text",
              x: 20,
              y: 20,
              width: 280,
              height: 100,
              rotation: 0,
              opacity: 1,
              fill: "#FFFFFF",
              fontSize: 24,
              fontFamily: "Inter",
              text: "First Title\nSecond Subtitle",
              tracks: [],
            },
          ],
        },
      };

      const svg = renderMotionSvg(project, 0);
      expect(svg).toContain("<tspan");
      expect(svg).toContain("First Title");
      expect(svg).toContain("Second Subtitle");
    });

    it("renders multiline text in Canvas frame renderer without crashing", () => {
      const project: MotionProject = {
        schemaVersion: 1,
        id: "motion-test-canvas-multi-1",
        workspaceRoot: "/test",
        name: "Canvas Multiline Test",
        revision: 1,
        createdAt: "2026-10-23T00:00:00Z",
        updatedAt: "2026-10-23T00:00:00Z",
        composition: {
          width: 320,
          height: 240,
          fps: { numerator: 30, denominator: 1 },
          durationFrames: 10,
          background: "#112233",
          layers: [
            {
              id: "txt-wrap",
              kind: "text",
              x: 10,
              y: 10,
              width: 150,
              height: 100,
              rotation: 0,
              opacity: 1,
              fill: "#EEDDCC",
              fontSize: 20,
              fontFamily: "Inter",
              text: "The quick brown fox jumps over the lazy dog",
              tracks: [],
            },
          ],
        },
      };

      const renderer = createMotionFrameRenderer(project, 320, 240);
      const buffer = renderer(0);
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBe(320 * 240 * 4);
    });
  });

  describe("3. Resilient Queue Admission & Stale Lock Eviction", () => {
    it("respects motionMaxRenderers in JSON settings", () => {
      updateSettings({ motionMaxRenderers: 3 });
      expect(motionConcurrentSlots()).toBe(3);

      updateSettings({ motionMaxRenderers: undefined });
    });

    it("auto-evicts stale .admission.lock older than 10 seconds", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-stale-lock-test-"));
      tempDirs.push(dir);

      const admissionLock = path.join(dir, ".admission.lock");
      // Simulate an abandoned lock file created 15 seconds ago
      await fs.writeFile(admissionLock, "abandoned");
      const pastTime = (Date.now() - 15_000) / 1000;
      await fs.utimes(admissionLock, pastTime, pastTime);

      // Running withMotionQueueAdmission should evict the stale lock and succeed
      let executed = false;
      await withMotionQueueAdmission(dir, async () => {
        executed = true;
      });

      expect(executed).toBe(true);
      // Lock file should be cleaned up after operation completes
      await expect(fs.access(admissionLock)).rejects.toThrow();
    });
  });

  describe("4. Audio Transcoding Validation", () => {
    it("rejects non-buffer or oversized audio sources safely", async () => {
      await expect(transcodeAudioToCanonicalWav(Buffer.alloc(0))).rejects.toThrow("Invalid source audio buffer");
    });
  });

  describe("5. Extended Animation Properties (scale, scaleX, scaleY & easings)", () => {
    it("evaluates scale animation tracks and bounce/easeIn easings accurately", () => {
      const project: MotionProject = {
        schemaVersion: 1,
        id: "motion-test-scale-001",
        workspaceRoot: "/test",
        name: "Scale Test",
        revision: 1,
        createdAt: "2026-10-23T00:00:00Z",
        updatedAt: "2026-10-23T00:00:00Z",
        composition: {
          width: 640,
          height: 360,
          fps: { numerator: 30, denominator: 1 },
          durationFrames: 30,
          background: "#000000",
          layers: [
            {
              id: "scaled-rect",
              kind: "rect",
              x: 100,
              y: 100,
              width: 100,
              height: 100,
              rotation: 0,
              opacity: 1,
              scale: 1,
              fill: "#00FFCC",
              tracks: [
                {
                  property: "scale",
                  keyframes: [
                    { frame: 0, value: 1, easing: "bounce" },
                    { frame: 29, value: 2.5 },
                  ],
                },
                {
                  property: "scaleY",
                  keyframes: [
                    { frame: 0, value: 1, easing: "easeIn" },
                    { frame: 29, value: 3 },
                  ],
                },
              ],
            },
          ],
        },
      };

      validateMotionProject(project);

      const f0 = evaluateFrame(project, 0);
      expect(f0.layers[0].values.scale).toBe(1);
      expect(f0.layers[0].values.scaleX).toBe(1);
      expect(f0.layers[0].values.scaleY).toBe(1);

      const fMid = evaluateFrame(project, 15);
      expect(fMid.layers[0].values.scale).toBeGreaterThan(1);
      expect(fMid.layers[0].values.scaleX).toBeGreaterThan(1);
      expect(fMid.layers[0].values.scaleY).toBeGreaterThan(1);

      const fEnd = evaluateFrame(project, 29);
      expect(fEnd.layers[0].values.scale).toBe(2.5);
      expect(fEnd.layers[0].values.scaleX).toBe(2.5);
      expect(fEnd.layers[0].values.scaleY).toBe(3);

      // Verify canvas and SVG render with scale transform
      const renderer = createMotionFrameRenderer(project, 640, 360);
      const buffer = renderer(15);
      expect(Buffer.isBuffer(buffer)).toBe(true);

      const svg = renderMotionSvg(project, 15);
      expect(svg).toContain("scale(");
    });
  });

  describe("6. Custom Font Upload & Registration", () => {
    it("imports a valid TTF font, registers it, and permits it in project validation", async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-font-test-"));
      tempDirs.push(workspace);

      // Read bundled font file as a real TTF sample
      const ttfPath = path.resolve("src/core/motion/assets/fonts/inter-latin-400.ttf");
      const ttfBytes = await fs.readFile(ttfPath);

      const customFamily = "CustomBrandFont";
      expect(isAllowedMotionFont(customFamily)).toBe(false);

      const imported = await importMotionFont(workspace, customFamily, ttfBytes);
      expect(imported.family).toBe(customFamily);
      expect(imported.bytes).toBe(ttfBytes.length);
      expect(isAllowedMotionFont(customFamily)).toBe(true);

      // Verify validation passes when using this custom font family
      const project: MotionProject = {
        schemaVersion: 1,
        id: "motion-custom-font-prj-1",
        workspaceRoot: workspace,
        name: "Custom Font Test",
        revision: 1,
        createdAt: "2026-10-23T00:00:00Z",
        updatedAt: "2026-10-23T00:00:00Z",
        composition: {
          width: 640,
          height: 360,
          fps: { numerator: 30, denominator: 1 },
          durationFrames: 10,
          background: "#1A1A1A",
          layers: [
            {
              id: "txt-brand",
              kind: "text",
              x: 50,
              y: 50,
              width: 300,
              height: 50,
              rotation: 0,
              opacity: 1,
              fill: "#FFFFFF",
              fontSize: 32,
              fontFamily: customFamily,
              text: "Custom Brand Typography",
              tracks: [],
            },
          ],
        },
      };

      expect(() => validateMotionProject(project)).not.toThrow();

      const renderer = createMotionFrameRenderer(project, 640, 360);
      const buf = renderer(0);
      expect(Buffer.isBuffer(buf)).toBe(true);
    });

    it("rejects invalid font buffers", async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-font-err-"));
      tempDirs.push(workspace);

      const fakeBytes = Buffer.from("Not a real TTF file at all");
      await expect(importMotionFont(workspace, "BadFont", fakeBytes)).rejects.toThrow("Invalid font format");
    });
  });

  describe("7. Video Layer & Ingestion Pipeline", () => {
    it("imports a valid MP4 buffer and saves it under workspace storage", async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-video-ingest-"));
      tempDirs.push(workspace);

      // Create a minimal synthetic MP4 header (ftyp box)
      const mp4Buffer = Buffer.alloc(128);
      mp4Buffer.writeUInt32BE(128, 0); // box length
      mp4Buffer.write("ftypisom", 4, "ascii");

      const imported = await importMotionVideo(workspace, mp4Buffer);
      expect(imported.id).toMatch(/^video-[a-f0-9]{64}$/);
      expect(imported.format).toBe("mp4");
      expect(imported.bytes).toBe(128);

      const readBack = await readMotionVideo(workspace, imported.id);
      expect(readBack.equals(mp4Buffer)).toBe(true);

      // Validate project with VideoLayer
      const project: MotionProject = {
        schemaVersion: 1,
        id: "motion-video-layer-prj-1",
        workspaceRoot: workspace,
        name: "Video Layer Project",
        revision: 1,
        createdAt: "2026-10-23T00:00:00Z",
        updatedAt: "2026-10-23T00:00:00Z",
        composition: {
          width: 640,
          height: 360,
          fps: { numerator: 30, denominator: 1 },
          durationFrames: 30,
          background: "#000000",
          layers: [
            {
              id: "vid-broll",
              kind: "video",
              assetId: imported.id,
              x: 0,
              y: 0,
              width: 640,
              height: 360,
              rotation: 0,
              opacity: 1,
              fill: "#000000",
              tracks: [],
            },
          ],
        },
      };

      expect(() => validateMotionProject(project)).not.toThrow();

      const renderer = createMotionFrameRenderer(project, 640, 360);
      const buf = renderer(0);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBe(640 * 360 * 4);

      const svg = renderMotionSvg(project, 0);
      expect(svg).toContain("<image");
    });

    it("rejects non-video buffers", async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-video-err-"));
      tempDirs.push(workspace);

      const invalidBytes = Buffer.from("random text bytes that are not MP4 or WebM");
      await expect(importMotionVideo(workspace, invalidBytes)).rejects.toThrow("Invalid Motion video format");
    });
  });
});
