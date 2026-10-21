import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyCompoundPreset } from "../src/core/motion/effects/compoundPresets.js";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import { renderMotionSvg } from "../src/core/motion/runtime/frameSvg.js";
import { renderMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))));
describe("Compound Motion H.264 and SVG rendering", () => {
  it("renders compound multi-phase frames as SVG and real H.264 MP4", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-compound-mp4-"));
    roots.push(root);
    const original = await createMotionProject(root, "Compound video");
    const short = structuredClone(original);
    short.composition.durationFrames = 30;
    short.composition.width = 160;
    short.composition.height = 90;
    const title = short.composition.layers[0];
    title.x = 15; title.y = 18; title.width = 125; title.height = 35;
    if (title.kind === "text") title.fontSize = 20;
    title.tracks = [];
    const composed = applyCompoundPreset(short, {
      presetId: "neon-impact", targetLayerId: title.id, durationFrames: 30,
    });
    validateMotionProject(composed);
    for (const frame of [0, 8, 15, 23, 29]) {
      const svg = renderMotionSvg(composed, frame);
      expect(svg).toContain("<svg");
      expect(svg).not.toContain("<script");
      expect(svg).toContain("#");
    }
    if (!(await probeFfmpeg())) return;
    const filename = path.join(root, ".superagent", "motion", "projects", original.id + ".json");
    await fs.writeFile(filename, JSON.stringify(composed), "utf8");
    const result = await renderMotionJob(root, original.id, { width: 160 });
    expect(result.status).toBe("completed");
    expect(result.framesCompleted).toBe(30);
    expect(result.artifact?.bytes).toBeGreaterThan(300);
    const bytes = await fs.readFile(result.artifact!.path);
    expect(bytes.toString("ascii", 4, 8)).toBe("ftyp");
    expect(result.artifact?.sha256).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
  }, 45000);
});
