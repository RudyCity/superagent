import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMotionProject, getMotionProject, updateMotionProject,
  listMotionProjectHistory, restoreMotionProjectHistory,
} from "../src/core/motion/project/projectStore.js";

describe("durable Motion revision recovery", () => {
  it("automatically archives revisions, restores by CAS, and archives the displaced current version", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-recover-"));
    try {
      const created = await createMotionProject(dir, "Recovery");
      const id = created.id;
      const second = await updateMotionProject(dir, id, 1, [{ type: "set-text", layerId: "title", text: "Second" }]);
      expect(second.revision).toBe(2);
      const third = await updateMotionProject(dir, id, 2, [{ type: "set-text", layerId: "title", text: "Third" }]);
      expect(third.revision).toBe(3);
      const history = await listMotionProjectHistory(dir, id);
      expect(history.map(item => item.revision)).toEqual([2, 1]);
      expect(history[0].updatedAt).toBe(second.updatedAt);
      await expect(restoreMotionProjectHistory(dir, id, 2, 1)).rejects.toThrow(/revision conflict/i);
      await expect(restoreMotionProjectHistory(dir, id, 3, 3)).rejects.toThrow(/historical revision/i);
      const restored = await restoreMotionProjectHistory(dir, id, 3, 1);
      expect(restored.revision).toBe(4);
      expect(restored.composition).toEqual(created.composition);
      expect((await getMotionProject(dir, id)).revision).toBe(4);
      expect((await listMotionProjectHistory(dir, id)).map(item => item.revision)).toEqual([3, 2, 1]);
      const original = await fs.readFile(path.join(dir, ".superagent", "studio", "projects",
        id + ".history", "r0000000001.json"), "utf8");
      expect(JSON.parse(original).composition).toEqual(created.composition);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("retains the newest 20 snapshots and rejects corrupted or symlinked history", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-history-bounded-"));
    try {
      let project = await createMotionProject(dir, "Retention");
      for (let i = 0; i < 23; i++) {
        project = await updateMotionProject(dir, project.id, project.revision,
          [{ type: "set-text", layerId: "title", text: "Edit " + i }]);
      }
      const history = await listMotionProjectHistory(dir, project.id);
      expect(history).toHaveLength(20);
      expect(history[0].revision).toBe(23);
      expect(history.at(-1)?.revision).toBe(4);
      await expect(restoreMotionProjectHistory(dir, project.id, 24, 1))
        .rejects.toThrow();
      const dirHistory = path.join(dir, ".superagent", "studio", "projects", project.id + ".history");
      await fs.writeFile(path.join(dirHistory, "r0000000023.json"), "invalid", "utf8");
      expect((await listMotionProjectHistory(dir, project.id)).some(item => item.revision === 23)).toBe(false);
      await expect(restoreMotionProjectHistory(dir, project.id, 24, 23)).rejects.toThrow();
      expect((await getMotionProject(dir, project.id)).revision).toBe(24);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
