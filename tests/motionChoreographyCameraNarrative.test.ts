import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  choreographSceneLayers,
  computeAnchoredScaling,
  applyInertialCameraMotion,
  generateSaaSPromo,
  createMotionProject,
  getMotionProject,
  type MotionLayer,
  type MotionProject,
} from "../src/core/motion/motionService.js";
import { evaluateTrack } from "../src/core/motion/timeline/evaluateFrame.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";

const dirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-choreography-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Superagent Motion Studio — World-Class Motion Engine (Linear / Apple / Stripe Standards)", () => {
  describe("1. Asymmetric Velocity Curves & Apple Easing (cubic-bezier(0.16, 1, 0.3, 1))", () => {
    it("evaluates apple curve with rapid front-loaded velocity and long smooth deceleration", () => {
      const track = {
        property: "opacity" as const,
        keyframes: [
          { frame: 0, value: 0, easing: "apple" as const },
          { frame: 100, value: 100 },
        ],
      };

      const at0 = evaluateTrack(track, 0);
      const at20 = evaluateTrack(track, 20); // 20% of duration
      const at50 = evaluateTrack(track, 50); // 50% of duration
      const at100 = evaluateTrack(track, 100);

      expect(at0).toBe(0);
      // Apple curve achieves >50% progress in the first 20% of the timeline
      expect(at20).toBeGreaterThan(50);
      // Apple curve achieves >90% progress by the midpoint
      expect(at50).toBeGreaterThan(90);
      expect(at100).toBe(100);
    });

    it("passes schema validation when apple easing is used in project keyframes", async () => {
      const ws = await makeTempWorkspace();
      const project = await createMotionProject(ws, "Apple Easing Project");
      project.composition.layers[0].tracks = [
        {
          property: "opacity",
          keyframes: [
            { frame: 0, value: 0, easing: "apple" },
            { frame: 30, value: 1 },
          ],
        },
      ];

      expect(() => validateMotionProject(project)).not.toThrow();
    });
  });

  describe("2. The 2–4 Frame Cascade & Stagger Choreography Engine", () => {
    it("assigns staggered entrance timing offsets according to visual hierarchy roles", () => {
      const layers: MotionLayer[] = [
        {
          id: "hero-card",
          kind: "rect",
          x: 100, y: 100, width: 400, height: 200, rotation: 0, opacity: 1, fill: "#111827",
          tracks: [{ property: "opacity", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] }],
        },
        {
          id: "section-headline-title",
          kind: "text",
          text: "Autonomous Multi-Agent",
          fontSize: 32, fontFamily: "Space Grotesk",
          x: 120, y: 120, width: 360, height: 40, rotation: 0, opacity: 1, fill: "#FFFFFF",
          tracks: [{ property: "opacity", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] }],
        },
        {
          id: "telemetry-chart-bar",
          kind: "rect",
          x: 120, y: 180, width: 200, height: 20, rotation: 0, opacity: 1, fill: "#10B981",
          tracks: [{ property: "opacity", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] }],
        },
      ];

      const choreographed = choreographSceneLayers(layers, {
        staggerIntervalFrames: 3,
        defaultEasing: "apple",
        durationFrames: 180,
      });

      const card = choreographed.find(l => l.id === "hero-card")!;
      const headline = choreographed.find(l => l.id === "section-headline-title")!;
      const bar = choreographed.find(l => l.id === "telemetry-chart-bar")!;

      const cardFrame = card.tracks[0].keyframes[1].frame;
      const headlineFrame = headline.tracks[0].keyframes[1].frame;
      const barFrame = bar.tracks[0].keyframes[1].frame;

      // Container card enters first, then headline, then telemetry chart bar
      expect(cardFrame).toBeLessThan(headlineFrame);
      expect(headlineFrame).toBeLessThan(barFrame);
      expect(card.tracks[0].keyframes[0].easing).toBe("apple");
    });

    it("computes anchor point discipline keyframes for left and bottom expansion", () => {
      const left = computeAnchoredScaling("left", 200, 300, 400, 50, 0, 30, 180);
      expect(left.scaleTrack.property).toBe("scaleX");
      expect(left.posTrack.property).toBe("x");
      // Initial X is compensated leftwards by width / 2
      expect(left.posTrack.keyframes[0].value).toBe(0); // 200 - 400 * 0.5 = 0
      expect(left.posTrack.keyframes[2].value).toBe(200);

      const bottom = computeAnchoredScaling("bottom", 200, 300, 400, 100, 0, 30, 180);
      expect(bottom.scaleTrack.property).toBe("scaleY");
      expect(bottom.posTrack.property).toBe("y");
      // Initial Y is compensated downwards by height / 2
      expect(bottom.posTrack.keyframes[0].value).toBe(350); // 300 + 100 * 0.5 = 350
      expect(bottom.posTrack.keyframes[2].value).toBe(300);
    });
  });

  describe("3. Simulated 3D Camera Mechanics & Z-Axis Depth Parallax", () => {
    it("applies isometric-to-orthographic reveal with rotation settling", () => {
      const layers: MotionLayer[] = [
        {
          id: "macbook-lid",
          kind: "rect",
          x: 100, y: 100, width: 800, height: 500, rotation: 0, opacity: 1, fill: "#18181B",
          tracks: [],
        },
      ];

      const withCam = applyInertialCameraMotion(layers, "isometric-reveal", {
        durationFrames: 180,
        easing: "apple",
      });

      const lid = withCam[0];
      const rot = lid.tracks.find(t => t.property === "rotation")!;
      const scale = lid.tracks.find(t => t.property === "scale")!;

      expect(rot).toBeDefined();
      expect(scale).toBeDefined();
      expect(rot.keyframes[0].value).toBeLessThan(0); // Tilted entrance
      expect(rot.keyframes[1].value).toBe(0); // Settles to 0 orthographic
      expect(scale.keyframes[0].value).toBe(0.92);
      expect(scale.keyframes[1].value).toBe(1.0);
    });

    it("applies multi-layer lateral dolly with Z-depth parallax differentiation", () => {
      const layers: MotionLayer[] = [
        {
          id: "global-ambient-aura", // Z = -200
          kind: "rect",
          x: 200, y: 200, width: 500, height: 300, rotation: 0, opacity: 0.1, fill: "#10B981",
          tracks: [],
        },
        {
          id: "sheen-light-beam", // Z = 85 (foreground)
          kind: "rect",
          x: 200, y: 200, width: 100, height: 300, rotation: 20, opacity: 0.15, fill: "#FFFFFF",
          tracks: [],
        },
      ];

      const withDolly = applyInertialCameraMotion(layers, "lateral-dolly", { durationFrames: 180 });
      const auraX = withDolly.find(l => l.id === "global-ambient-aura")!.tracks.find(t => t.property === "x")!;
      const sheenX = withDolly.find(l => l.id === "sheen-light-beam")!.tracks.find(t => t.property === "x")!;

      const auraLast = auraX.keyframes[auraX.keyframes.length - 1].value;
      const sheenLast = sheenX.keyframes[sheenX.keyframes.length - 1].value;
      const auraDelta = Math.abs(auraLast - auraX.keyframes[0].value);
      const sheenDelta = Math.abs(sheenLast - sheenX.keyframes[0].value);

      // Foreground layer travels further than deep background layer (true parallax)
      expect(sheenDelta).toBeGreaterThan(auraDelta);
    });
  });

  describe("4. 4-Act SaaS Narrative Arc Generator (Linear/Raycast/Stripe Formula)", () => {
    it("synthesizes end-to-end 4-Act SaaS promo with living aura, laser runner, mockup, benchmark and CTA", async () => {
      const ws = await makeTempWorkspace();
      const { project, job } = await generateSaaSPromo(ws, {
        productName: "Superagent",
        tagline: "Autonomous Multi-Agent Velocity",
        palette: "emerald",
        device: "macbook",
        width: 1280,
        height: 720,
        voiceover: false, // test structure without audio first
      });

      expect(project.revision).toBe(2);
      expect(job.status).toBe("queued");

      const comp = project.composition;
      expect(comp.durationFrames).toBe(900); // Exactly 30 seconds at 30fps

      const ids = comp.layers.map(l => l.id);
      // Global living atmosphere
      expect(ids).toContain("global-living-aura");
      expect(ids).toContain("global-timeline-laser");

      // Act 1: The Hook
      expect(ids).toContain("act1-hook-container");
      expect(ids).toContain("act1-command-chip");
      expect(ids).toContain("act1-hero-headline");

      // Act 2: The Core Engine
      expect(ids.some(id => id.startsWith("mockup-macbook-"))).toBe(true);
      expect(ids.some(id => id.startsWith("code-"))).toBe(true);

      // Act 3: Telemetry & Proof
      expect(ids.some(id => id.startsWith("chart-bench-bar-"))).toBe(true);

      // Act 4: The Resolution & CTA
      expect(ids).toContain("act4-cta-card");
      expect(ids).toContain("act4-brand-headline");
      expect(ids).toContain("act4-install-pill");
      expect(ids).toContain("act4-install-txt");
      expect(ids.some(id => id.includes("sheen"))).toBe(true);
    });

    it("triggers saas-promo via CLI command with --wait and returns clean exit code 0", async () => {
      const ws = await makeTempWorkspace();

      const exitCode = await handleMotionCliCommand([
        "saas-promo",
        "--product", "Superagent",
        "--tagline", "Autonomous Terminal Intelligence",
        "--palette", "cyber",
        "--device", "browser",
        "--width", "640",
        "--workspace", ws,
        "--json",
      ]);

      expect(exitCode).toBe(0);
      const { listMotionProjects } = await import("../src/core/motion/motionService.js");
      const projects = await listMotionProjects(ws);
      expect(projects.length).toBe(1);
    });
  });
});
