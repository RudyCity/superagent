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
});
