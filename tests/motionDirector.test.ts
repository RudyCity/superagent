import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateMotionFromPrompt, reviseMotionFromPrompt, validateDirectorPlan,
  compileDirectorPlan, type MotionDirectorPlan } from "../src/core/motion/director/directorService.js";
import { getMotionProject, listMotionProjects } from "../src/core/motion/project/projectStore.js";
import { getMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";
import { getToolByName } from "../src/core/tools/index.js";
import { superagentToolset } from "../src/core/tools/toolsets.js";

const workspaces: string[] = [];
const plan: MotionDirectorPlan = {
  name: "Laris Product Promo", background: "#171B28", durationSeconds: 3,
  scenes: [
    { headline: "Laris makin cepat", accent: "#FFCA32", subtitle: "Promo terbaru" },
    { headline: "Mulai sekarang!", accent: "#00B8FF" },
  ],
};
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-director-"));
  workspaces.push(root);
  return root;
};
async function waitCompleted(workspace: string, id: string) {
  for (let n = 0; n < 150; n++) {
    const job = await getMotionJob(workspace, id);
    if (["completed", "failed", "cancelled", "interrupted"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return getMotionJob(workspace, id);
}
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});
describe("AI Motion Director prompt -> editable scene -> detached video", () => {
  it("exposes high-level native tools in the actual SuperAgent agent toolset", () => {
    expect(getToolByName("motion_generate")?.name).toBe("motion_generate");
    expect(getToolByName("motion_revise")?.name).toBe("motion_revise");
    expect(getToolByName("motion_status")?.name).toBe("motion_status");
    expect(superagentToolset.some(tool => tool.name === "motion_generate")).toBe(true);
    expect(superagentToolset.some(tool => tool.name === "motion_revise")).toBe(true);
  });
  it("fails closed on invalid AI data without creating a project", async () => {
    const workspace = await fixture();
    const planner = vi.fn().mockResolvedValue({
      ...plan, scenes: [{ headline: "<script>", accent: "javascript:bad" }],
    });
    await expect(generateMotionFromPrompt(workspace, "Video pendek", { planner })).rejects.toThrow(/invalid/);
    expect(await listMotionProjects(workspace)).toHaveLength(0);
    await expect(generateMotionFromPrompt(workspace, "x".repeat(2001), { planner })).rejects.toThrow(/2000/);
    expect(planner).toHaveBeenCalledTimes(1);
  });
  it("compiles deterministic, validated, revisioned multi-section scene data", () => {
    expect(validateDirectorPlan(plan).scenes).toHaveLength(2);
    const composition = compileDirectorPlan(plan);
    expect(composition.durationFrames).toBe(90);
    expect(composition.layers.filter(layer => layer.kind === "text")).toHaveLength(3);
    expect(composition.layers.some(layer => layer.id === "scene-1-title")).toBe(true);
    for (const layer of composition.layers) {
      for (const track of layer.tracks) {
        expect(track.keyframes.map(k => k.frame)).toEqual([...track.keyframes.map(k => k.frame)].sort((a,b) => a-b));
        expect(track.keyframes.at(-1)!.frame).toBeLessThan(composition.durationFrames);
      }
    }
  });
  it("turns an Indonesian brief into H264 MP4, then revises only requested text", async () => {
    if (!await probeFfmpeg()) return;
    const workspace = await fixture();
    const planner = vi.fn().mockResolvedValueOnce({ ...plan, motion: "slide-up", transition: "crossfade" }).mockResolvedValueOnce({
      edits: [{ type: "set-text", layerId: "scene-1-title", text: "Cepat dan mudah!" }],
    });
    const generated = await generateMotionFromPrompt(workspace,
      "Buat video promosi Laris modern dengan teks animasi", { width: 160, planner });
    expect(generated.outline).toEqual(["Laris makin cepat", "Mulai sekarang!"]);
    expect(generated.project.revision).toBe(2);
    expect(generated.quality.passed).toBe(true);
    expect(generated.quality.samples).toHaveLength(2);
    expect(generated.project.composition.layers.find(layer => layer.id === "scene-1-title")?.tracks
      .some(track => track.property === "y")).toBe(true);
    const first = await waitCompleted(workspace, generated.job.id);
    expect(first.status).toBe("completed");
    expect(first.artifact?.bytes).toBeGreaterThan(1000);
    expect(first.artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const previousScene = await getMotionProject(workspace, generated.project.id);
    const revised = await reviseMotionFromPrompt(workspace, generated.project.id,
      "Ubah judul terakhir menjadi Cepat dan mudah", { width: 160, planner });
    expect(revised.project.revision).toBe(3);
    expect(revised.quality.passed).toBe(true);
    expect(revised.project.composition.layers.find(layer => layer.id === "scene-1-title"))
      .toMatchObject({ text: "Cepat dan mudah!" });
    expect(revised.project.composition.layers.find(layer => layer.id === "scene-0-title"))
      .toEqual(previousScene.composition.layers.find(layer => layer.id === "scene-0-title"));
    expect((await waitCompleted(workspace, revised.job.id)).status).toBe("completed");
  }, 50000);
  it("rejects forged layer IDs and destructive model output without touching revision", async () => {
    const workspace = await fixture();
    const generated = await generateMotionFromPrompt(workspace, "Video product",
      { planner: async () => plan, width: 160 });
    const before = generated.project.revision;
    await expect(reviseMotionFromPrompt(workspace, generated.project.id, "Hapus semua",
      { planner: async () => ({ edits: [{ type: "replace-composition", composition: {} }] }) }))
      .rejects.toThrow(/unsupported/);
    await expect(reviseMotionFromPrompt(workspace, generated.project.id, "Ganti judul",
      { planner: async () => ({ edits: [{ type: "set-text", layerId: "foreign", text: "No" }] }) }))
      .rejects.toThrow(/foreign/);
    expect((await getMotionProject(workspace, generated.project.id)).revision).toBe(before);
    await waitCompleted(workspace, generated.job.id);
  }, 35000);
});
