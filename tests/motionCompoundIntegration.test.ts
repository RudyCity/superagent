import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { createMotionProject, getMotionProject } from "../src/core/motion/project/projectStore.js";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";
import { compileDirectorPlan, validateDirectorPlan } from "../src/core/motion/director/directorService.js";
import { motionCommand } from "../src/core/commands/motionCommand.js";
import type { ChatLine, SlashCommandContext } from "../src/core/commands/types.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";

let root: string;
let server: http.Server;
let base: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-compound-integration-"));
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleMotionHttpRoute(req, res, url.pathname, url, {
      resolveWorkspacePath: () => root,
      sendJSON: (reply, status, obj) => {
        reply.writeHead(status, { "Content-Type": "application/json" });
        reply.end(JSON.stringify(obj));
      },
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const a = server.address(); if (!a || typeof a === "string") throw new Error("Port unavailable");
  base = "http://127.0.0.1:" + a.port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  await fs.rm(root, { recursive: true, force: true });
});
describe("Compound Motion presets: HTTP, CLI, slash and prompt director", () => {
  it("offers discoverable preset catalog with HTTP item lookup", async () => {
    const list = await (await fetch(base + "/api/motion/presets?q=neon")).json() as any;
    expect(list.count).toBe(1);
    expect(list.presets[0].id).toBe("neon-impact");
    const item = await (await fetch(base + "/api/motion/presets/neon-impact")).json() as any;
    expect(item.entrance).toBe("entrance-whip-left");
    expect((await fetch(base + "/api/motion/presets/not-valid")).status).toBe(404);
    expect((await fetch(base + "/api/motion/presets?q=" + "x".repeat(121))).status).toBe(400);
  });
  it("validates HTTP request and commits a preset as one revision", async () => {
    const project = await createMotionProject(root, "Compound API");
    const endpoint = base + "/api/motion/projects/" + project.id + "/presets";
    const send = async (body: object) => fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const payload = { presetId: "neon-impact", targetLayerId: project.composition.layers[0].id, baseRevision: 1 };
    expect((await send({ ...payload, intensity: "boost" })).status).toBe(400);
    expect((await send({ ...payload, presetId: "not-a-preset" })).status).toBe(400);
    expect((await getMotionProject(root, project.id)).revision).toBe(1);
    const ok = await send(payload);
    expect(ok.status).toBe(200);
    const updated = await ok.json() as any;
    expect(updated.revision).toBe(2);
    expect(updated.composition.layers[0].tracks.length).toBeGreaterThan(0);
    expect((await send(payload)).status).toBe(409);
    expect((await getMotionProject(root, project.id)).revision).toBe(2);
  });
  it("supports CLI listing and applying a preset using the same transactional service", async () => {
    const project = await createMotionProject(root, "Compound CLI");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await handleMotionCliCommand(["presets", "--search", "bold", "--json", "--workspace", root])).toBe(0);
      expect(log.mock.calls.join(" ")).toContain("bold-hero");
      expect(await handleMotionCliCommand(["preset-info", "bold-hero", "--json", "--workspace", root])).toBe(0);
      expect(await handleMotionCliCommand([
        "apply-preset", project.id, "--preset", "bold-hero", "--layer", project.composition.layers[0].id,
        "--base-revision", "1", "--duration-frames", "65", "--workspace", root, "--json",
      ])).toBe(0);
      expect((await getMotionProject(root, project.id)).revision).toBe(2);
    } finally { log.mockRestore(); }
  });
  it("supports /motion preset discovery and apply command", async () => {
    const project = await createMotionProject(root, "Compound Slash");
    const entries: ChatLine[] = [];
    const ctx = { agent: { workingDirectory: root }, addLine: (l: ChatLine) => entries.push(l) } as SlashCommandContext;
    await motionCommand.execute("presets", ctx);
    expect(entries.at(-1)?.content).toContain("neon-impact");
    await motionCommand.execute("preset neon-impact", ctx);
    expect(entries.at(-1)?.content).toContain("entrance-whip-left");
    await motionCommand.execute("apply-preset " + project.id + " 1 neon-impact " + project.composition.layers[0].id, ctx);
    expect(entries.at(-1)?.content).toContain("revision 2");
    expect((await getMotionProject(root, project.id)).revision).toBe(2);
  });
  it("compiles prompt-directed compound presets for 2 scenes and rejects fake presets", () => {
    const input = {
      name: "Neon Reveal", durationSeconds: 5, background: "#111827",
      artDirection: "neon" as const, aspectRatio: "9:16" as const, preset: "neon-impact",
      scenes: [
        { headline: "HELLO", accent: "#36F4D3" },
        { headline: "WORLD", accent: "#FFDF59", preset: "editorial-reveal" },
      ],
    };
    const composition = compileDirectorPlan(validateDirectorPlan(input));
    expect(composition.layers.find(layer => layer.id === "scene-0-title")!.tracks.length).toBeGreaterThan(1);
    expect(composition.layers.some(layer => layer.id.startsWith("preset-neon-impact"))).toBe(true);
    expect(composition.layers.some(layer => layer.id.startsWith("preset-editorial-reveal"))).toBe(true);
    const project = {
      schemaVersion: 1 as const, id: "motion-director-presets-00001", workspaceRoot: root,
      name: "Scene", revision: 1,
      createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z", composition,
    };
    validateMotionProject(project);
    expect(() => validateDirectorPlan({ ...input, preset: "not-real" })).toThrow();
    expect(() => validateDirectorPlan({ ...input, scenes: [
      { ...input.scenes[0], preset: "not-real" },
    ] })).toThrow();
  });
});
