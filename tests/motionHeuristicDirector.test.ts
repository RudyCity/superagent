import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createHeuristicDirectorPlan,
  validateDirectorPlan,
  generateMotionFromPrompt,
} from "../src/core/motion/director/directorService.js";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";

const testDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-heuristic-test-"));
  testDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(testDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Motion Director Offline Heuristic Storyboard & CLI --wait", () => {
  it("generates structurally valid 3-scene storyboards across design keywords", () => {
    const neon = createHeuristicDirectorPlan("Cyberpunk Neon Glowing Smart AI");
    expect(neon.artDirection).toBe("neon");
    expect(neon.scenes).toHaveLength(3);
    expect(() => validateDirectorPlan(neon)).not.toThrow();

    const brutal = createHeuristicDirectorPlan("Diskon Kilat Bold Geometry Sale");
    expect(brutal.artDirection).toBe("brutalist");
    expect(brutal.scenes).toHaveLength(3);
    expect(() => validateDirectorPlan(brutal)).not.toThrow();

    const clean = createHeuristicDirectorPlan("Desain Simple Elegan Minimalis");
    expect(clean.artDirection).toBe("minimal");
    expect(clean.scenes).toHaveLength(3);
    expect(() => validateDirectorPlan(clean)).not.toThrow();
  });

  it("completes full generation and render synchronously via CLI --wait flag", async () => {
    if (!(await probeFfmpeg())) return;
    const ws = await createTempWorkspace();

    const exitCode = await handleMotionCliCommand([
      "generate",
      "--prompt", "Promo Kilat Produk Unggulan",
      "--wait",
      "--width", "160",
      "--workspace", ws,
      "--json",
    ]);

    expect(exitCode).toBe(0);

    const rendersDir = path.join(ws, ".superagent", "studio", "renders");
    const files = await fs.readdir(rendersDir);
    const mp4Files = files.filter(f => f.endsWith(".mp4") && !f.includes("partial"));
    expect(mp4Files.length).toBeGreaterThan(0);
  }, 45000);
});
