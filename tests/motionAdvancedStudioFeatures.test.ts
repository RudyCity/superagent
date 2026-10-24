import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";
import { createMotionProject, getMotionProject } from "../src/core/motion/project/projectStore.js";
import {
  compileAudioVisualizerLayers,
  extractAudioEnergyProfile,
  attachAudioVisualizerToProject,
} from "../src/core/motion/visualizer/audioVisualizer.js";
import {
  tokenizeCodeLine,
  compileCodeCardLayers,
} from "../src/core/motion/code/codeCardCompiler.js";
import {
  getMotionPalette,
  listMotionPalettes,
  compileSpecularSheenLayer,
  applyPaletteToComposition,
} from "../src/core/motion/palettes/colorPalettes.js";
import {
  inspectWorkspaceRepository,
  inspectChangelogRelease,
  generateRepoReel,
  generateReleasePromo,
} from "../src/core/motion/autonomous/repoReelGenerator.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";

const testDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-adv-features-"));
  testDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(testDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})));
});

describe("Superagent Motion Studio Advanced Features (1-4)", () => {
  describe("1. Audio-Reactive Waveforms & Equalizer", () => {
    it("extracts multi-band energy profile and compiles equalizer layers", () => {
      const profile = extractAudioEnergyProfile(undefined, 30, 60, 12);
      expect(profile).toHaveLength(60);
      expect(profile[0]).toHaveLength(12);
      expect(profile[0][0]).toBeGreaterThanOrEqual(0.05);

      const layers = compileAudioVisualizerLayers({
        type: "equalizer",
        fps: 30,
        durationFrames: 60,
        x: 100,
        y: 400,
        width: 300,
        height: 60,
        accentColor: "#38BDF8",
        barCount: 12,
      });

      expect(layers).toHaveLength(12);
      expect(layers[0].kind).toBe("rect");
      expect(layers[0].id).toBe("audio-eq-bar-0");
      expect(layers[0].tracks.some(t => t.property === "scaleY")).toBe(true);
    });

    it("compiles waveform and pulse-ring visualizer types", () => {
      const waveLayers = compileAudioVisualizerLayers({
        type: "waveform",
        durationFrames: 45,
        x: 50,
        y: 300,
        width: 400,
        height: 50,
        accentColor: "#10B981",
        barCount: 16,
      });
      expect(waveLayers).toHaveLength(16);
      expect(waveLayers[0].id).toBe("audio-wave-seg-0");

      const pulseLayers = compileAudioVisualizerLayers({
        type: "pulse-ring",
        durationFrames: 45,
        x: 200,
        y: 200,
        width: 100,
        height: 100,
        accentColor: "#A855F7",
      });
      expect(pulseLayers).toHaveLength(3);
      expect(pulseLayers[0].id).toBe("audio-pulse-ring-0");
      expect(pulseLayers[0].tracks.some(t => t.property === "scale")).toBe(true);
    });

    it("attaches audio visualizer to an existing project via CLI", async () => {
      const ws = await createTempWorkspace();
      const project = await createMotionProject(ws, "Visualizer Target");

      const exitCode = await handleMotionCliCommand([
        "audio-visualizer",
        project.id,
        "--base-revision", "1",
        "--type", "equalizer",
        "--accent", "#38BDF8",
        "--workspace", ws,
        "--json",
      ]);

      expect(exitCode).toBe(0);
      const updated = await getMotionProject(ws, project.id);
      expect(updated.revision).toBe(2);
      expect(updated.composition.layers.some(l => l.id.startsWith("audio-eq-bar-"))).toBe(true);
    });
  });

  describe("2. Animated Syntax-Highlighted Code Card", () => {
    it("tokenizes code line into keywords, strings, types, and numbers", () => {
      const tokens = tokenizeCodeLine('const maxIterations: number = 42; // default loop');
      const textTokens = tokens.map(t => t.text);
      expect(textTokens).toContain("const");
      expect(textTokens).toContain("number");
      expect(textTokens).toContain("42");

      const kw = tokens.find(t => t.text === "const");
      expect(kw?.kind).toBe("keyword");
      expect(kw?.color).toBe("#F43F5E");

      const comment = tokens.find(t => t.kind === "comment");
      expect(comment?.text).toBe("// default loop");
    });

    it("compiles full code card with chrome, line numbers, and typing tracks", () => {
      const code = `import { MasterAgent } from "superagent";\nconst agent = new MasterAgent();\nawait agent.execute();`;
      const layers = compileCodeCardLayers({
        code,
        filename: "testAgent.ts",
        language: "TypeScript",
        x: 100,
        y: 100,
        width: 800,
        height: 450,
        startFrame: 0,
        endFrame: 90,
        typing: true,
      });

      expect(layers.some(l => l.id === "code-card-bg")).toBe(true);
      expect(layers.some(l => l.id === "code-dot-red")).toBe(true);
      expect(layers.some(l => l.id === "code-card-file")).toBe(true);
      expect(layers.some(l => l.id === "code-line-num-1")).toBe(true);
      expect(layers.some(l => l.id === "code-typing-cursor")).toBe(true);
    });

    it("adds code card to existing project via CLI command", async () => {
      const ws = await createTempWorkspace();
      const project = await createMotionProject(ws, "Code Showcase");

      const exitCode = await handleMotionCliCommand([
        "code-card",
        project.id,
        "--base-revision", "1",
        "--code", 'const x = "hello";',
        "--file", "demo.ts",
        "--lang", "TypeScript",
        "--workspace", ws,
        "--json",
      ]);

      expect(exitCode).toBe(0);
      const updated = await getMotionProject(ws, project.id);
      expect(updated.revision).toBe(2);
      expect(updated.composition.layers.some(l => l.id === "code-card-bg")).toBe(true);
    });
  });

  describe("3. Curated Palettes & Specular Sheen Sweep", () => {
    it("lists curated design palettes and applies palette colors", () => {
      const palettes = listMotionPalettes();
      expect(palettes.length).toBeGreaterThanOrEqual(7);
      expect(palettes.some(p => p.id === "cyber")).toBe(true);
      expect(palettes.some(p => p.id === "nord")).toBe(true);
      expect(palettes.some(p => p.id === "emerald")).toBe(true);

      const cyber = getMotionPalette("cyber");
      expect(cyber?.accent).toBe("#00F0FF");

      const dummyProj = {
        schemaVersion: 1 as const,
        id: "proj-1",
        workspaceRoot: "/",
        name: "Test",
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        composition: {
          width: 1920,
          height: 1080,
          fps: { numerator: 30, denominator: 1 },
          durationFrames: 60,
          background: "#000000",
          layers: [
            {
              id: "scene-0-hero-card",
              kind: "rect" as const,
              x: 100, y: 100, width: 600, height: 300,
              rotation: 0, opacity: 1, fill: "#FFFFFF",
              tracks: [],
            },
          ],
        },
      };

      const applied = applyPaletteToComposition(dummyProj, "emerald");
      expect(applied.composition.background).toBe("#061A14");
      expect(applied.composition.layers[0].fill).toBe("#0A2E23");
    });

    it("compiles specular sheen sweep reflection layer", () => {
      const sheen = compileSpecularSheenLayer({
        cardX: 200,
        cardY: 200,
        cardWidth: 800,
        cardHeight: 400,
        startFrame: 0,
        endFrame: 60,
      });

      expect(sheen.id).toBe("card-specular-sheen");
      expect(sheen.rotation).toBe(-20);
      expect(sheen.tracks.some(t => t.property === "x")).toBe(true);
      expect(sheen.tracks.some(t => t.property === "opacity")).toBe(true);
    });

    it("lists palettes via CLI command", async () => {
      const exitCode = await handleMotionCliCommand(["palettes", "--json"]);
      expect(exitCode).toBe(0);
    });
  });

  describe("4. Autonomous Repo-to-Reel & Changelog Promo", () => {
    it("inspects current workspace package.json, README.md, and git log", async () => {
      const repo = await inspectWorkspaceRepository(".");
      expect(repo.name).toBe("superagent");
      expect(repo.version).toBeDefined();
      expect(repo.description).toBeDefined();
      expect(Array.isArray(repo.features)).toBe(true);
      expect(Array.isArray(repo.recentCommits)).toBe(true);
    });

    it("inspects CHANGELOG.md for target release version", async () => {
      const release = await inspectChangelogRelease(".", "1.14.30");
      expect(release.version).toBe("1.14.30");
      expect(release.highlights.length).toBeGreaterThan(0);
      expect(release.highlights[0]).toContain("High-Density Scene Content");
    });

    it("generates repo-reel motion project autonomously", async () => {
      const ws = await createTempWorkspace();
      // Write mock package.json
      await fs.writeFile(path.join(ws, "package.json"), JSON.stringify({
        name: "AcmeBot",
        version: "2.5.0",
        description: "Autonomous Agent Orchestrator",
      }));
      await fs.writeFile(path.join(ws, "README.md"), "# AcmeBot\n\n- **Sub-Second Boot**: Instant execution\n- **Distributed Task Mesh**: Scalable concurrency\n");

      const result = await generateRepoReel(ws, {
        style: "minimal",
        palette: "nord",
        width: 160,
      });

      expect(result.project.name).toContain("AcmeBot");
      expect(result.quality.passed).toBe(true);
      expect(result.project.composition.layers.length).toBeGreaterThan(5);
    });

    it("executes repo-reel and release-promo via CLI", async () => {
      if (!(await probeFfmpeg())) return;
      const ws = await createTempWorkspace();
      await fs.writeFile(path.join(ws, "package.json"), JSON.stringify({
        name: "TestProject",
        version: "1.0.0",
        description: "Agent Automation Suite",
      }));
      await fs.writeFile(path.join(ws, "README.md"), "# Test\n\n- **Fast Kernel**: Blazing speed\n");

      const exitCode = await handleMotionCliCommand([
        "repo-reel",
        "--style", "neon",
        "--wait",
        "--width", "160",
        "--workspace", ws,
        "--json",
      ]);

      expect(exitCode).toBe(0);
    }, 45000);
  });
});
