import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isCanonicalMotionWorkspaceAllowed } from "../src/core/motion/workspaceAccess.js";

const roots: string[] = [];
async function directory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-workspace-access-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Motion API workspace canonicalization", () => {
  it("accepts registered descendants while denying foreign roots", async () => {
    const root = await directory();
    const child = path.join(root, "child");
    const outsider = await directory();
    await fs.mkdir(child);
    expect(isCanonicalMotionWorkspaceAllowed(root, [root])).toBe(true);
    expect(isCanonicalMotionWorkspaceAllowed(child, [root])).toBe(true);
    expect(isCanonicalMotionWorkspaceAllowed(outsider, [root])).toBe(false);
    expect(isCanonicalMotionWorkspaceAllowed("ssh://server/workspace", [root])).toBe(false);
  });
  it("rejects symlink escapes from a trusted root", async () => {
    const root = await directory();
    const outside = await directory();
    const escape = path.join(root, "escape");
    try {
      await fs.symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(isCanonicalMotionWorkspaceAllowed(escape, [root])).toBe(false);
  });
});
