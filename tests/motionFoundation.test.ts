import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMotionProject, getMotionProject, listMotionProjects, updateMotionProject, writeMotionPreview } from "../src/core/motion/motionService.js";
import { evaluateFrame } from "../src/core/motion/timeline/evaluateFrame.js";
import { renderMotionSvg } from "../src/core/motion/runtime/frameSvg.js";
import { MotionRevisionConflict } from "../src/core/motion/project/revisions.js";
import { MotionValidationError, validateMotionProject } from "../src/core/motion/schema/validation.js";

const created: string[] = [];
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-motion-"));
  created.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(created.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Motion Studio foundation", () => {
  it("creates an owned project with a deterministic 10-second preview and random seek", async () => {
    const root = await workspace();
    const project = await createMotionProject(root, "Launch & <Grow>");
    expect(project.revision).toBe(1);
    expect(project.composition.durationFrames).toBe(300);
    const beginning = evaluateFrame(project, 0);
    const middle = evaluateFrame(project, 12);
    const ending = evaluateFrame(project, 24);
    expect(beginning.layers[0].values.opacity).toBe(0);
    expect(middle.layers[0].values.opacity).toBeCloseTo(0.5);
    expect(ending.layers[0].values.opacity).toBe(1);
    expect(evaluateFrame(project, 12)).toEqual(middle);
    expect(() => evaluateFrame(project, 300)).toThrow(RangeError);
    const svg = renderMotionSvg(project, 12);
    expect(svg).toContain("Launch &amp; &lt;Grow&gt;");
    expect(svg).not.toContain("<Grow>");
    const first = await writeMotionPreview(root, project.id, 12);
    const second = await writeMotionPreview(root, project.id, 12);
    expect(first).toEqual(second);
    expect((await fs.readFile(first.path, "utf8"))).toBe(svg);
    expect(await listMotionProjects(root)).toEqual([{ id: project.id, name: "Launch & <Grow>", revision: 1 }]);
  });

  it("uses revision guards and atomic transactions without mutating stale snapshots", async () => {
    const root = await workspace();
    const first = await createMotionProject(root, "Before");
    const second = await updateMotionProject(root, first.id, 1, [{ type: "set-text", layerId: "title", text: "After" }]);
    expect(second.revision).toBe(2);
    expect(second.composition.layers[0]).toMatchObject({ text: "After" });
    expect(first.composition.layers[0]).toMatchObject({ text: "Before" });
    await expect(updateMotionProject(root, first.id, 1, [{ type: "set-text", layerId: "title", text: "Overwrite" }]))
      .rejects.toBeInstanceOf(MotionRevisionConflict);
    expect((await getMotionProject(root, first.id)).revision).toBe(2);
    await expect(updateMotionProject(root, first.id, 2, [{ type: "set-property", layerId: "title", property: "opacity", value: 2 }]))
      .rejects.toBeInstanceOf(MotionValidationError);
    expect((await getMotionProject(root, first.id)).revision).toBe(2);
  });

  it("creates, reorders, removes, and restores layers with revision guards", async () => {
    const root = await workspace();
    const first = await createMotionProject(root, "Layer CRUD");
    const rectangle = {
      id: "panel", kind: "rect" as const, x: 10, y: 12,
      width: 80, height: 60, rotation: 0, opacity: 1,
      fill: "#4C80EE", tracks: [],
    };
    const added = await updateMotionProject(root, first.id, 1, [{ type: "add-layer", layer: rectangle, index: 0 }]);
    expect(added.composition.layers.map(item => item.id)).toEqual(["panel", "title"]);
    const moved = await updateMotionProject(root, first.id, 2, [{ type: "move-layer", layerId: "panel", toIndex: 1 }]);
    expect(moved.composition.layers.map(item => item.id)).toEqual(["title", "panel"]);
    const removed = await updateMotionProject(root, first.id, 3, [{ type: "remove-layer", layerId: "title" }]);
    expect(removed.composition.layers.map(item => item.id)).toEqual(["panel"]);
    const restored = await updateMotionProject(root, first.id, 4, [{ type: "replace-composition", composition: first.composition }]);
    expect(restored.revision).toBe(5);
    expect(restored.composition.layers).toEqual(first.composition.layers);
    await expect(updateMotionProject(root, first.id, 4, [{ type: "add-layer", layer: rectangle }]))
      .rejects.toBeInstanceOf(MotionRevisionConflict);
  });

  it("rejects invalid layer insertion, duplicate layer ids and malformed scene replacement", async () => {
    const root = await workspace();
    const first = await createMotionProject(root, "Guarded");
    await expect(updateMotionProject(root, first.id, 1, [{ type: "add-layer", layer: first.composition.layers[0] }]))
      .rejects.toThrow("already exists");
    await expect(updateMotionProject(root, first.id, 1, [{ type: "move-layer", layerId: "title", toIndex: 5 }]))
      .rejects.toThrow();
    const invalid = structuredClone(first.composition);
    invalid.layers[0].fill = "url(https://bad.example)";
    await expect(updateMotionProject(root, first.id, 1, [{ type: "replace-composition", composition: invalid }]))
      .rejects.toBeInstanceOf(MotionValidationError);
    expect((await getMotionProject(root, first.id)).revision).toBe(1);
  });

  it("rejects invalid tracks, properties, duplicate layers and non-declarative fields", async () => {
    const root = await workspace();
    const project = await createMotionProject(root, "Valid");
    const invalid = structuredClone(project);
    invalid.composition.layers[0].tracks[0].keyframes.reverse();
    expect(() => validateMotionProject(invalid)).toThrow(MotionValidationError);
    const malicious = structuredClone(project) as typeof project & { script: string };
    malicious.script = "require('fs')";
    expect(() => validateMotionProject(malicious)).toThrow(MotionValidationError);
    const duplicates = structuredClone(project);
    duplicates.composition.layers.push(structuredClone(duplicates.composition.layers[0]));
    expect(() => validateMotionProject(duplicates)).toThrow(MotionValidationError);
  });

  it("enforces workspace ownership and rejects symlinked motion storage", async () => {
    const root = await workspace();
    const other = await workspace();
    const project = await createMotionProject(root, "One");
    await expect(getMotionProject(other, project.id)).rejects.toThrow();
    await expect(getMotionProject(root, "../" + project.id)).rejects.toThrow();
    const target = path.join(root, ".superagent", "motion", "projects", project.id + ".json");
    await fs.copyFile(target, path.join(other, ".superagent", "motion", "projects", project.id + ".json")).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(path.join(other, ".superagent", "motion", "projects"), { recursive: true });
      await fs.copyFile(target, path.join(other, ".superagent", "motion", "projects", project.id + ".json"));
    });
    await expect(getMotionProject(other, project.id)).rejects.toThrow("owned by another workspace");
  });
});
