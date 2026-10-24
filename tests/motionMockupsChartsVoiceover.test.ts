import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMotionProject,
  getMotionProject,
  listDeviceMockups,
  compileDeviceMockupLayers,
  attachDeviceMockupToProject,
  compileMotionChartLayers,
  attachChartToProject,
  synthesizeDeterministicSpeechWav,
  autoFitCompositionToVoiceover,
  compileVoiceoverBurnInSubtitles,
  generateVoiceoverForProject,
} from "../src/core/motion/motionService.js";
import { inspectMotionWav } from "../src/core/motion/assets/motionAudio.js";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";

const dirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-mockup-chart-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Superagent Motion Studio Extensions — Mockups, Charts, Voiceover", () => {
  describe("1. 3D Perspective Device Mockups & Parallax Tilt", () => {
    it("lists all available device presets", () => {
      const presets = listDeviceMockups();
      expect(presets.length).toBeGreaterThanOrEqual(3);
      const ids = presets.map(p => p.id);
      expect(ids).toContain("macbook");
      expect(ids).toContain("iphone");
      expect(ids).toContain("browser");
    });

    it("compiles macbook mockup layers with lid, screen, camera notch, base, and reflection", () => {
      const layers = compileDeviceMockupLayers({
        device: "macbook",
        x: 100,
        y: 100,
        width: 800,
        height: 500,
        startFrame: 0,
        endFrame: 120,
        title: "Superagent Terminal",
        parallaxTilt: true,
      });

      expect(layers.length).toBeGreaterThanOrEqual(6);
      const ids = layers.map(l => l.id);
      expect(ids).toContain("mockup-macbook-shadow-diffuse");
      expect(ids).toContain("mockup-macbook-lid");
      expect(ids).toContain("mockup-macbook-screen");
      expect(ids).toContain("mockup-macbook-camera");
      expect(ids).toContain("mockup-macbook-base");
      expect(ids).toContain("mockup-macbook-glass-sheen");

      // Verify parallax tilt keyframes are valid integers
      const lid = layers.find(l => l.id === "mockup-macbook-lid")!;
      const rotTrack = lid.tracks.find(t => t.property === "rotation");
      expect(rotTrack).toBeDefined();
      for (const kf of rotTrack!.keyframes) {
        expect(Number.isInteger(kf.frame)).toBe(true);
        expect(kf.frame).toBeLessThanOrEqual(120);
      }
    });

    it("compiles iphone mockup layers with dynamic island and home bar", () => {
      const layers = compileDeviceMockupLayers({
        device: "iphone",
        x: 200,
        y: 50,
        width: 380,
        height: 760,
        startFrame: 0,
        endFrame: 90,
        parallaxTilt: true,
      });

      const ids = layers.map(l => l.id);
      expect(ids).toContain("mockup-iphone-chassis");
      expect(ids).toContain("mockup-iphone-screen");
      expect(ids).toContain("mockup-iphone-island");
      expect(ids).toContain("mockup-iphone-home-bar");
    });

    it("compiles browser mockup layers with traffic lights and URL pill", () => {
      const layers = compileDeviceMockupLayers({
        device: "browser",
        x: 100,
        y: 80,
        width: 900,
        height: 540,
        startFrame: 0,
        endFrame: 90,
        url: "https://superagent.sh/cloud",
      });

      const ids = layers.map(l => l.id);
      expect(ids).toContain("mockup-browser-window");
      expect(ids).toContain("mockup-browser-header");
      expect(ids).toContain("mockup-browser-dot-1");
      expect(ids).toContain("mockup-browser-dot-2");
      expect(ids).toContain("mockup-browser-dot-3");
      expect(ids).toContain("mockup-browser-url-pill");
      expect(ids).toContain("mockup-browser-url-text");
    });

    it("attaches device mockup to an existing project via CLI command", async () => {
      const ws = await makeTempWorkspace();
      const project = await createMotionProject(ws, "Mockup Test Video");

      const exitCode = await handleMotionCliCommand([
        "mockup",
        project.id,
        "--base-revision", "1",
        "--device", "macbook",
        "--title", "Superagent Autonomous Core",
        "--workspace", ws,
        "--json",
      ]);

      expect(exitCode).toBe(0);
      const updated = await getMotionProject(ws, project.id);
      expect(updated.revision).toBe(2);
      expect(updated.composition.layers.some(l => l.id.startsWith("mockup-macbook-"))).toBe(true);
    });
  });

  describe("2. Animated Benchmark Charts & KPI Counters", () => {
    it("compiles benchmark comparison bars with compensated X scale tracks", () => {
      const layers = compileMotionChartLayers({
        type: "benchmark",
        x: 80,
        y: 80,
        width: 800,
        height: 450,
        startFrame: 0,
        endFrame: 150,
        title: "Execution Velocity",
        items: [
          { label: "Superagent 3-Tier", value: 0.35, displayValue: "0.35s", isHero: true },
          { label: "Sequential Agent", value: 2.40, displayValue: "2.40s" },
        ],
      });

      const ids = layers.map(l => l.id);
      expect(ids).toContain("chart-benchmark-card-bg");
      expect(ids).toContain("chart-benchmark-title-txt");
      expect(ids).toContain("chart-bench-lbl-1");
      expect(ids).toContain("chart-bench-bar-1");
      expect(ids).toContain("chart-bench-val-1");
      expect(ids).toContain("chart-bench-bar-2");

      const bar1 = layers.find(l => l.id === "chart-bench-bar-1")!;
      const scaleXTrack = bar1.tracks.find(t => t.property === "scaleX");
      const xTrack = bar1.tracks.find(t => t.property === "x");
      expect(scaleXTrack).toBeDefined();
      expect(xTrack).toBeDefined();
    });

    it("compiles kpi hero card with glowing orb and trend badge", () => {
      const layers = compileMotionChartLayers({
        type: "kpi",
        x: 100,
        y: 100,
        width: 600,
        height: 340,
        startFrame: 0,
        endFrame: 120,
        kpiValue: "99.9%",
        kpiLabel: "Autonomous Reliability",
        kpiBadge: "+52% Efficiency",
      });

      const ids = layers.map(l => l.id);
      expect(ids).toContain("chart-kpi-card-bg");
      expect(ids).toContain("chart-kpi-glow-orb");
      expect(ids).toContain("chart-kpi-value-txt");
      expect(ids).toContain("chart-kpi-label-txt");
      expect(ids).toContain("chart-kpi-badge-bg");
      expect(ids).toContain("chart-kpi-badge-txt");

      const valTxt = layers.find(l => l.id === "chart-kpi-value-txt") as any;
      expect(valTxt.text).toBe("99.9%");
    });

    it("compiles radial progress ring with strokeDashoffset animation", () => {
      const layers = compileMotionChartLayers({
        type: "radial",
        x: 100,
        y: 80,
        width: 600,
        height: 480,
        startFrame: 0,
        endFrame: 120,
        progressPercent: 95,
      });

      const ids = layers.map(l => l.id);
      expect(ids).toContain("chart-radial-track");
      expect(ids).toContain("chart-radial-active");
      expect(ids).toContain("chart-radial-val-txt");

      const activeArc = layers.find(l => l.id === "chart-radial-active")!;
      expect(activeArc.kind).toBe("path");
      const dashTrack = activeArc.tracks.find(t => t.property === "strokeDashoffset");
      expect(dashTrack).toBeDefined();
    });

    it("attaches chart to project via CLI command", async () => {
      const ws = await makeTempWorkspace();
      const project = await createMotionProject(ws, "Chart Promo");

      const exitCode = await handleMotionCliCommand([
        "chart",
        project.id,
        "--base-revision", "1",
        "--type", "kpi",
        "--kpi-value", "0ms",
        "--title", "Cold Start Latency",
        "--badge", "Sub-Millisecond",
        "--workspace", ws,
        "--json",
      ]);

      expect(exitCode).toBe(0);
      const updated = await getMotionProject(ws, project.id);
      expect(updated.revision).toBe(2);
      expect(updated.composition.layers.some(l => l.id === "chart-kpi-value-txt")).toBe(true);
    });
  });

  describe("3. Autonomous AI Voiceover & Scene Duration Auto-Fit", () => {
    it("synthesizes valid canonical PCM16 WAV matching spoken text pacing", () => {
      const narration = "Superagent transforms terminal workflows with autonomous speed.";
      const wav = synthesizeDeterministicSpeechWav(narration, { sampleRate: 16000, wordsPerMinute: 150 });

      expect(wav.length).toBeGreaterThan(44);
      const meta = inspectMotionWav(wav);
      expect(meta.channels).toBe(1);
      expect(meta.sampleRate).toBe(16000);
      expect(meta.seconds).toBeGreaterThanOrEqual(1.0);
      expect(meta.seconds).toBeLessThanOrEqual(10.0);
    });

    it("auto-fits composition duration and scales layer keyframes when voice duration exceeds timeline", async () => {
      const ws = await makeTempWorkspace();
      const project = await createMotionProject(ws, "Short Video");

      const comp = project.composition;
      expect(comp.durationFrames).toBe(300); // 10 seconds default

      // Audio is 12 seconds long (375 frames needed at 30fps with 0.5s buffer)
      const fitted = autoFitCompositionToVoiceover(comp, 12.0, 0.5);
      expect(fitted.durationFrames).toBeGreaterThanOrEqual(375);
    });

    it("compiles burn-in subtitle pill layers", () => {
      const subs = compileVoiceoverBurnInSubtitles(
        "Empowering engineers with high-velocity AI agents.",
        1920,
        1080,
        0,
        180,
        "#F59E0B",
      );

      expect(subs.length).toBe(3);
      const ids = subs.map(l => l.id);
      expect(ids).toContain("subtitles-pill-bg");
      expect(ids).toContain("subtitles-accent-pip");
      expect(ids).toContain("subtitles-narration-txt");

      const txt = subs.find(l => l.id === "subtitles-narration-txt") as any;
      expect(txt.text).toBe("Empowering engineers with high-velocity AI agents.");
    });

    it("generates voiceover, imports asset, auto-fits timeline and burns subtitles via CLI", async () => {
      const ws = await makeTempWorkspace();
      const project = await createMotionProject(ws, "Voiceover Test Video");

      const exitCode = await handleMotionCliCommand([
        "voiceover",
        project.id,
        "--base-revision", "1",
        "--text", "Superagent multi-agent architecture operates with extreme precision.",
        "--workspace", ws,
        "--json",
      ]);

      expect(exitCode).toBe(0);
      const updated = await getMotionProject(ws, project.id);
      expect(updated.revision).toBe(2);
      expect(updated.composition.audioTracks).toBeDefined();
      expect(updated.composition.audioTracks?.some(t => t.role === "voiceover")).toBe(true);
      expect(updated.composition.layers.some(l => l.id === "subtitles-pill-bg")).toBe(true);
    });
  });
});
