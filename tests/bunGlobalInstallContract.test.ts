import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", source), "utf8"));
const lockText = readFileSync(new URL("bun.lock", source), "utf8");

describe("SuperAgent Bun global-install SQLite dependency contract", () => {
  it("pins r-memory with the Bun-native SQLite packaging fix", () => {
    expect(manifest.dependencies["r-memory"]).toContain("64c718ce05c103a2d4e6218505279d990b55488f");
    expect(lockText).toContain(manifest.dependencies["r-memory"]);
    expect(lockText).toContain('"optionalPeers": ["better-sqlite3"]');
  });
  it("does not resolve better-sqlite3 as a mandatory package", () => {
    expect(manifest.dependencies).not.toHaveProperty("better-sqlite3");
    expect(lockText).not.toContain('"better-sqlite3": ["better-sqlite3@');
  });
  it("documents compiler-free source startup instead of unreliable global-dot installation", () => {
    const readme = readFileSync(new URL("README.md", source), "utf8");
    expect(readme).toContain("bun install --frozen-lockfile");
    expect(readme).toContain("bun dist/cli.js --version");
    expect(readme).toContain("bun run start");
    expect(readme).toContain("bun run dev");
    expect(readme).toContain("verified standalone installer");
    expect(readme).toContain("Avoid `bun install -g .`");
    expect(readme).not.toContain("bun install -g .\nsuperagent");
  });
});
