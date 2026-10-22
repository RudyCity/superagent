import { afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { matchesWorkspaceGlob, scanWorkspaceGlob } from "../src/core/tools/nativeGlob.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bun-native-glob-"));
for(const name of ["src/a.ts", "src/a.tsx", "src/nested/b.ts", "node_modules/c.ts", "dist/d.ts", ".git/e.ts"]) {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive:true });
  fs.writeFileSync(target, "fixture");
}
afterAll(() => fs.rmSync(dir,{recursive:true,force:true}));

describe("Bun-native workspace glob compatibility", () => {
  it("matches recursive and brace TS glob with excluded folders", async () => {
    const files=await scanWorkspaceGlob("**/*.{ts,tsx}",dir);
    expect(files).toEqual(["src/a.ts", "src/a.tsx", "src/nested/b.ts"]);
    expect(await scanWorkspaceGlob("**/*.ts",dir,true)).toEqual([
      path.join(dir,"src","a.ts"),path.join(dir,"src","nested","b.ts"),
    ]);
  });
  it("normalizes Windows separators and excludes node_modules from cache matches", () => {
    expect(matchesWorkspaceGlob("**/*.ts", "src\\nested\\b.ts")).toBe(true);
    expect(matchesWorkspaceGlob("**/*.ts", "node_modules/pkg/c.ts")).toBe(false);
  });
  it("fails closed on deep braces before scanning", async () => {
    await expect(scanWorkspaceGlob("{".repeat(30)+"a"+"}".repeat(30),dir)).rejects.toThrow(/nesting/);
  });
});
