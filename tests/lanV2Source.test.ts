import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LanDiskSourceV2 } from "../src/core/lanRemote/streamSourceV2.js";

const roots: string[] = [];
const sha256 = (buffer: Buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-lan-source-v2-"));
  roots.push(root);
  const data = crypto.randomBytes(4 * 1024 * 1024 + 91);
  const source = path.join(root, "owner-large.bin");
  await fs.writeFile(source, data);
  return { root, source, data };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Owner-selected Windows V2 streaming source", () => {
  it("streams >4MiB in 16KiB chunks, permits only last-chunk read recovery and verifies twice", async () => {
    const { data, source } = await fixture();
    const engine = new LanDiskSourceV2();
    const selected = await engine.select(source);
    expect(selected).toEqual({ name: "owner-large.bin", size: data.length, sha256: sha256(data) });
    const offer = await engine.offer(engine.getShared()!.revision);
    expect(offer.direction).toBe("download");
    const downloaded = Buffer.alloc(data.length);
    for (let offset = 0, seq = 0; offset < data.length; seq++) {
      const chunk = await engine.get(offer.transferId, seq);
      const bytes = Buffer.from(chunk.data, "base64");
      bytes.copy(downloaded, offset);
      offset += bytes.length;
      if (seq === 0) expect(await engine.get(offer.transferId, seq)).toEqual(chunk);
      if (seq === 1)
        await expect(engine.get(offer.transferId, seq - 2)).rejects.toThrow();
    }
    expect(downloaded).toEqual(data);
    const done = await engine.finish(offer.transferId);
    expect(done.bytes).toBe(data.length);
    expect(await engine.finish(offer.transferId)).toEqual(done);
    expect(JSON.stringify(await engine.status(offer.transferId))).not.toContain(source);
  }, 50_000);

  it("requires a renewed local source selection and fails closed if owner changes it", async () => {
    const { source, root, data } = await fixture();
    const second = path.join(root, "other-large.bin");
    await fs.writeFile(second, data);
    const engine = new LanDiskSourceV2();
    await engine.select(source);
    const oldRevision = engine.getShared()!.revision;
    await engine.select(second);
    await expect(engine.offer(oldRevision)).rejects.toThrow("changed");
    const offer = await engine.offer(engine.getShared()!.revision);
    await fs.appendFile(second, Buffer.from([17]));
    await expect(engine.get(offer.transferId, 0)).rejects.toThrow("changed");
    engine.clear();
    expect(engine.getShared()).toBeNull();
    expect(() => engine.status(offer.transferId)).toThrow();
  });

  it("refuses source symlinks, hidden files and legacy-sized files", async () => {
    const { root, source } = await fixture();
    const engine = new LanDiskSourceV2();
    const link = path.join(root, "alias.bin");
    await fs.symlink(source, link);
    await expect(engine.select(link)).rejects.toThrow();
    const hidden = path.join(root, ".private.bin");
    await fs.copyFile(source, hidden);
    await expect(engine.select(hidden)).rejects.toThrow();
    const little = path.join(root, "small.bin");
    await fs.writeFile(little, Buffer.from("small"));
    await expect(engine.select(little)).rejects.toThrow("above 4 MiB");
  });
});
