import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerProject } from "../src/core/project/projectRegistry.js";
import { createBrainSession } from "../src/core/brain/brainWorkspace.js";
import { bindBrainProject, verifyBrainProject } from "../src/core/brain/brainProvenance.js";

const roots: string[] = [];
afterEach(() => {
  delete process.env.SUPERAGENT_CONFIG_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe("Brain project origin and RMemory isolation", () => {
  it("binds to a registered origin and refuses other projects on resume", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-project-provenance-"));
    roots.push(root); process.env.SUPERAGENT_CONFIG_DIR = root;
    const a = path.join(root, "apps", "first");
    const b = path.join(root, "apps", "second");
    fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
    registerProject({ id: "first", name: "First", type: "local", root: a });
    registerProject({ id: "second", name: "Second", type: "local", root: b });
    createBrainSession("local-cli", "session_original");
    expect(bindBrainProject("local-cli", "session_original", a)?.projectId).toBe("first");
    expect(verifyBrainProject("local-cli", "session_original", a).projectId).toBe("first");
    expect(() => verifyBrainProject("local-cli", "session_original", b)).toThrow(/differs/);
    expect(() => bindBrainProject("local-cli", "session_original", b)).toThrow(/reassigned/);
    createBrainSession("local-cli", "session_detached");
    expect(() => verifyBrainProject("local-cli", "session_detached", a)).toThrow(/no registered/);
  });
});
