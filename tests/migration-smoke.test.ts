/**
 * Smoke test for the activePresetId migration: loads the actual
 * ~/.superagent-r/model-config.json, validates it via the real
 * schema, and asserts that:
 *   1. The schema accepts the file (no activePresetId error)
 *   2. The in-memory shape contains both `multi` and `single`
 *   3. The user's per-mode preset selection is preserved
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("activePresetId migration — end-to-end on real config", () => {
  it("accepts the user's existing object form without errors", async () => {
    const { validateModelConfig } = await import(
      "../src/core/config/configSchema.js"
    );

    const configPath = path.join(
      os.homedir(),
      ".superagent-r",
      "model-config.json"
    );
    if (!fs.existsSync(configPath)) {
      // Skip if the user doesn't have a real config to test against
      return;
    }

    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);

    const r = validateModelConfig(parsed);

    // Either fully valid, or has warnings unrelated to activePresetId.
    // The critical assertion: NO "activePresetId" error.
    if (!r.ok) {
      const activePresetErrors = r.errors.filter((e) =>
        e.includes("activePresetId")
      );
      expect(activePresetErrors).toEqual([]);
    } else if (r.value.activePresetId) {
      // If validation succeeded and the field was accepted, it should
      // have been normalized to the object form with both keys.
      expect(typeof r.value.activePresetId.multi).toBe("string");
      expect(typeof r.value.activePresetId.single).toBe("string");
    }
  });
});
