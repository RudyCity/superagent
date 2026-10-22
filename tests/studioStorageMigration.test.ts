import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMotionProject, getMotionProject, listMotionProjects,
  motionStorageDir, studioStorageRoot, inspectStudioStorageMigration, migrateStudioStorage,
} from "../src/core/motion/project/projectStore.js";
import { writeMotionPreview } from "../src/core/motion/motionService.js";

const roots: string[] = [];
async function root() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-migration-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});
describe("Studio namespace and legacy Motion storage migration", () => {
  it("creates only the Studio namespace for new workspaces", async () => {
    const ws = await root();
    const project = await createMotionProject(ws, "New Studio");
    expect(await motionStorageDir(ws)).toBe(path.join(ws, ".superagent", "studio", "projects"));
    expect((await getMotionProject(ws, project.id)).name).toBe("New Studio");
    expect(await fs.readdir(path.join(ws, ".superagent"))).toEqual(["studio"]);
    expect((await inspectStudioStorageMigration(ws)).state).toBe("already-studio");
  });
  it("keeps legacy projects available until explicit operator migration", async () => {
    const ws = await root();
    const project = await createMotionProject(ws, "Existing scene");
    const home = path.join(ws, ".superagent");
    const legacy = path.join(home, "motion");
    const studio = path.join(home, "studio");
    await fs.rename(studio, legacy);
    expect((await getMotionProject(ws, project.id)).name).toBe("Existing scene");
    expect(await studioStorageRoot(ws)).toBe(legacy);
    expect((await inspectStudioStorageMigration(ws)).state).toBe("legacy");
    expect(await migrateStudioStorage(ws)).toMatchObject({ migrated: true, from: legacy, to: studio });
    expect(await fs.readdir(home)).toEqual(["studio"]);
    expect((await getMotionProject(ws, project.id)).id).toBe(project.id);
    expect(await listMotionProjects(ws)).toEqual([{ id: project.id, name: project.name, revision: 1 }]);
    expect((await writeMotionPreview(ws, project.id, 0)).path).toContain(path.join(".superagent", "studio", "previews"));
  });
  it("refuses concurrent render jobs and preexisting claims", async () => {
    const ws = await root();
    await createMotionProject(ws, "Queue test");
    const home = path.join(ws, ".superagent");
    await fs.rename(path.join(home, "studio"), path.join(home, "motion"));
    const jobs = path.join(home, "motion", "jobs");
    await fs.mkdir(jobs);
    const id = "motionjob-" + "a".repeat(24);
    await fs.writeFile(path.join(jobs, id + ".json"), JSON.stringify({ status: "rendering" }));
    expect((await inspectStudioStorageMigration(ws)).blockers).toHaveLength(1);
    await expect(migrateStudioStorage(ws)).rejects.toThrow(/blocked/);
    await fs.writeFile(path.join(jobs, id + ".json"), JSON.stringify({ status: "completed" }));
    await fs.writeFile(path.join(jobs, "render.runner.lock"), "locked");
    await expect(migrateStudioStorage(ws)).rejects.toThrow(/blocked/);
    await fs.rm(path.join(jobs, "render.runner.lock"));
    expect((await inspectStudioStorageMigration(ws)).blockers).toEqual([]);
    expect((await migrateStudioStorage(ws)).migrated).toBe(true);
  });
  it("rejects nested locks and incomplete video artifacts before namespace cutover", async () => {
    const ws = await root();
    await createMotionProject(ws, "Incomplete");
    const home = path.join(ws, ".superagent");
    await fs.rename(path.join(home, "studio"), path.join(home, "motion"));
    const renders = path.join(home, "motion", "renders");
    await fs.mkdir(renders);
    await fs.writeFile(path.join(renders, "motionjob-a.partial.mp4"), "not complete");
    const first = await inspectStudioStorageMigration(ws);
    expect(first.state).toBe("legacy");
    expect(first.blockers.some(item => item.includes("partial.mp4"))).toBe(true);
    await expect(migrateStudioStorage(ws)).rejects.toThrow(/blocked/);
    await fs.rm(path.join(renders, "motionjob-a.partial.mp4"));
    const assets = path.join(home, "motion", "assets");
    await fs.mkdir(assets);
    await fs.writeFile(path.join(assets, "reconcile.lock"), "active");
    expect((await inspectStudioStorageMigration(ws)).blockers).toEqual([
      expect.stringContaining("reconcile.lock"),
    ]);
    await fs.rm(path.join(assets, "reconcile.lock"));
    expect((await migrateStudioStorage(ws)).migrated).toBe(true);
  });

  it("does not merge ambiguous directories or follow symbolic links", async () => {
    const ws = await root();
    await createMotionProject(ws, "Original");
    const home = path.join(ws, ".superagent");
    await fs.mkdir(path.join(home, "motion"));
    expect((await inspectStudioStorageMigration(ws)).state).toBe("conflict");
    await expect(createMotionProject(ws, "Danger")).rejects.toThrow(/Both Studio and legacy/);
    await expect(migrateStudioStorage(ws)).rejects.toThrow(/blocked/);
  });
});
