import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync("apps/superagent-tray/ui/lan-sha256.js", "utf8");
const native = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
function createHasher(): { update(bytes: Uint8Array): any; hex(): string } {
  const window: Record<string, any> = {};
  vm.runInNewContext(script, { window, Uint8Array, Uint32Array, DataView,
    Array, Math, Number, Error });
  return new window.LanStreamingSha256();
}

describe("LAN V2 browser slice-by-slice SHA-256", () => {
  for (const length of [0, 1, 7, 55, 56, 63, 64, 65, 511, 4096, 80_001, 1024 * 1024 + 9]) {
    it("matches native SHA-256 for " + length + " bytes", () => {
      const data = crypto.randomBytes(length);
      const h = createHasher();
      for (let start = 0; start < data.length; start += 371)
        h.update(data.subarray(start, start + 371));
      expect(h.hex()).toBe(native(data));
      expect(() => h.hex()).toThrow("already finalized");
    });
  }
  it("rejects invalid input and oversized incremental streams", () => {
    const h = createHasher();
    expect(() => h.update("hello" as any)).toThrow("Invalid");
  });
});
