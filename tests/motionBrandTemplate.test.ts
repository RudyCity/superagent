import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMotionProject, updateMotionProject } from "../src/core/motion/project/projectStore.js";
import { getMotionBrandKit, saveMotionBrandKit } from "../src/core/motion/motionBrandKit.js";
import { listMotionTemplates, compileMotionTemplate } from "../src/core/motion/motionTemplates.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";

describe("workspace-owned Motion Brand Kit and scene templates", () => {
  it("stores palette/font with revision locking, input validation and workspace separation", async () => {
    const first = await fs.mkdtemp(path.join(os.tmpdir(), "motion-brand-one-"));
    const second = await fs.mkdtemp(path.join(os.tmpdir(), "motion-brand-two-"));
    try {
      const initial = await getMotionBrandKit(first);
      expect(initial.revision).toBe(0);
      const next = await saveMotionBrandKit(first, 0, {
        name: "Laris", primary: "#1a2b3c", accent: "#aa5500",
        background: "#111111", textColor: "#ffffff", fontFamily: "Helvetica",
      });
      expect(next.revision).toBe(1);
      expect((await getMotionBrandKit(first)).name).toBe("Laris");
      expect((await getMotionBrandKit(second)).revision).toBe(0);
      await expect(saveMotionBrandKit(first, 0, {
        name: "Wrong", primary: "#1a2b3c", accent: "#aa5500",
        background: "#111111", textColor: "#ffffff", fontFamily: "Helvetica",
      })).rejects.toThrow(/revision conflict/i);
      await expect(saveMotionBrandKit(first, 1, {
        ...next, name: "Bad", primary: "red",
      } as any)).rejects.toThrow();
      await expect(saveMotionBrandKit(first, 1, {
        name: "Invalid logo", primary: "#1a2b3c", accent: "#aa5500",
        background: "#111111", textColor: "#ffffff", fontFamily: "Helvetica",
        logoAssetId: "asset-" + "a".repeat(64),
      })).rejects.toThrow();
      expect((await getMotionBrandKit(first)).revision).toBe(1);
    } finally {
      await fs.rm(first, { recursive: true, force: true });
      await fs.rm(second, { recursive: true, force: true });
    }
  });

  it("compiles all curated templates with brand colors, preserves audio and supports revisioned save", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-templates-"));
    try {
      const project = await createMotionProject(dir, "Template gallery");
      const brand = await getMotionBrandKit(dir);
      const gallery = listMotionTemplates();
      expect(gallery).toHaveLength(6);
      for (const template of gallery) {
        const composition = compileMotionTemplate(project, brand, {
          templateId: template.id, headline: "Ship faster", subtitle: "New feature available",
        });
        validateMotionProject({ ...project, composition });
        expect(composition.layers.some(layer => layer.kind === "text" && layer.text === "Ship faster")).toBe(true);
        expect(composition.background).toBe(brand.background);
        expect(composition.durationFrames).toBe(project.composition.durationFrames);
      }
      const result = compileMotionTemplate(project, brand, { templateId: "product-launch" });
      expect((await updateMotionProject(dir, project.id, 1, [
        { type: "replace-composition", composition: result },
      ])).revision).toBe(2);
      expect(() => compileMotionTemplate(project, brand, { templateId: "random-unknown" })).toThrow();
      expect(() => compileMotionTemplate(project, brand, { templateId: "product-launch", headline: "x".repeat(300) })).toThrow();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
