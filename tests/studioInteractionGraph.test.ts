import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createMotionProject, getMotionProject, updateMotionProject } from "../src/core/motion/project/projectStore.js";
import { renderStudioNativeHtml } from "../src/core/motion/code/studioNativeCodeExporter.js";
import { validateMotionProject, MotionValidationError } from "../src/core/motion/schema/validation.js";
import type { MotionProject, StudioInteractionGraph } from "../src/core/motion/schema/types.js";
import { applyMotionEdits, MotionRevisionConflict } from "../src/core/motion/project/revisions.js";
import { compileMotionEffectStack } from "../src/core/motion/effects/effectStack.js";

const dirs: string[] = [];
async function fixture() {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "studio-interaction-"));
  dirs.push(ws);
  return { ws, project: await createMotionProject(ws, "Interaction Graph") };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
const graph = (): StudioInteractionGraph => ({ version: 1, bindings: [
  { id: "rule-cta-click", target: "layer", layerId: "title", event: "click", action: "replay" },
  { id: "rule-on-hover", target: "stage", event: "mouseenter", action: "pause" },
  { id: "rule-on-leave", target: "stage", event: "mouseleave", action: "play" },
  { id: "rule-on-scroll", target: "stage", event: "scroll", action: "seek" },
] });

describe("Studio Interaction Graph v1", () => {
  it("persists revisioned rules, reads them back, and supports removal", async () => {
    const { ws, project } = await fixture();
    const saved = await updateMotionProject(ws, project.id, 1, [{ type: "set-interaction-graph", graph: graph() }]);
    expect(saved.revision).toBe(2);
    expect(saved.composition.interactionGraph).toEqual(graph());
    const read = await getMotionProject(ws, project.id);
    expect(read.composition.interactionGraph).toEqual(graph());
    await expect(updateMotionProject(ws, project.id, 1, [{ type: "set-interaction-graph", graph: null }]))
      .rejects.toBeInstanceOf(MotionRevisionConflict);
    const cleaned = await updateMotionProject(ws, project.id, 2, [{ type: "set-interaction-graph", graph: null }]);
    expect(cleaned.revision).toBe(3);
    expect(cleaned.composition.interactionGraph).toBeUndefined();
  });
  it("exports graph to offline HTML and the graph overrides legacy default trigger", async () => {
    const { project } = await fixture();
    const saved = applyMotionEdits(project, 1, [{ type: "set-interaction-graph", graph: graph() }]);
    const html = renderStudioNativeHtml(saved, "autoplay");
    expect(html).toContain('"graph":{"version":1');
    expect(html).toContain('"layerId":"title"');
    expect(html).toContain('if(!scene.graph && scene.trigger==="autoplay")play();');
    expect(html).toContain('id="studio-scroll-space"');
    expect(html).toContain('<body class="scroll">');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(() => new vm.Script(html.match(/<script>([\s\S]+?)<\/script>/)![1])).not.toThrow();
  });
  it("rejects script injection, unknown events, missing layers, and inappropriate progress", async () => {
    const { project } = await fixture();
    const base = graph();
    const invalids: StudioInteractionGraph[] = [
      { ...base, bindings: [...base.bindings, { id: "bad-script", event: "click", action: "replay", target: "stage", eval: "alert(1)" } as never] },
      { ...base, bindings: [...base.bindings, { id: "rule-danger", event: "network" as never, action: "play", target: "stage" }] },
      { ...base, bindings: [{ id: "rule-missing", event: "click", target: "layer", layerId: "nope", action: "replay" }] },
      { ...base, bindings: [{ id: "rule-progress", event: "click", target: "stage", action: "seek", progress: 2 }] },
      { ...base, bindings: [{ id: "rule-scroller", event: "scroll", target: "layer", layerId: "title", action: "seek" }] },
      { ...base, bindings: new Array(13).fill({ id: "rule-overflow", event: "click", target: "stage", action: "replay" }) },
    ];
    for (const bad of invalids) {
      const altered: MotionProject = structuredClone(project);
      altered.composition.interactionGraph = bad;
      expect(() => validateMotionProject(altered)).toThrow(MotionValidationError);
    }
  });
  it("prevents removal of an interactive target and retains rules through effect-stack recompilation", async () => {
    const { project } = await fixture();
    const bound = applyMotionEdits(project, 1, [{ type: "set-interaction-graph", graph: graph() }]);
    expect(() => applyMotionEdits(bound, 2, [{ type: "remove-layer", layerId: "title" }]))
      .toThrow(/referenced layer does not exist/);
    const stacked: MotionProject = { ...bound, composition: compileMotionEffectStack(bound, [
      { id: "intro-fade", effectId: "entrance-fade-in", enabled: true, targetLayerId: "title", durationFrames: 30 }
    ]) };
    const nextGraph: StudioInteractionGraph = { version: 1, bindings: [
      { id: "rule-ready", event: "ready", target: "stage", action: "play" }
    ] };
    const edited = applyMotionEdits(stacked, 2, [{ type: "set-interaction-graph", graph: nextGraph }]);
    expect(edited.composition.interactionGraph).toEqual(nextGraph);
    expect(edited.composition.stackBase?.interactionGraph).toEqual(nextGraph);
  });
});
