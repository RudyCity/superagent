import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCommandLog } from "../src/core/tools/commandLogger.js";
import { readCommandOutputPage, rollingCommandOutput } from "../src/core/tools/commandOutputPaging.js";
import { readCliLogPage } from "../src/core/tools/cliBridgeObservability.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-log-paging-"));
const temporaryLogs: string[] = [];
afterAll(() => {
  for (const file of temporaryLogs) fs.rmSync(file, { force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("lossless paged output", () => {
  it("caps preview without dropping bytes from the persistent command log", async () => {
    const logger = createCommandLog("output paging test", workspace);
    temporaryLogs.push(logger.logPath);
    const output = Array.from({ length: 1400 }, (_, i) => "Line " + i + " — مرحبا 🔎 hello\n").join("");
    const capture = rollingCommandOutput(3000);
    const codepoints = Array.from(output);
    for (let i = 0; i < codepoints.length; i += 47) {
      const chunk = codepoints.slice(i, i + 47).join("");
      logger.write(chunk);
      capture.append(chunk);
    }
    logger.end(0);
    expect(capture.clipped).toBe(true);
    expect(capture.preview(logger.id).length).toBeLessThan(3400);
    expect(capture.preview(logger.id)).toContain(logger.id);

    let cursor = 0;
    let pages = 0;
    let restored = "";
    for (;;) {
      const page = await readCommandOutputPage(logger.id, workspace, cursor, 257);
      restored += page.text;
      expect(page.offsetBytes).toBe(cursor);
      expect(page.nextOffsetBytes).toBeGreaterThanOrEqual(cursor);
      pages++;
      if (!page.hasMore) break;
      expect(page.nextOffsetBytes).toBeGreaterThan(cursor);
      cursor = page.nextOffsetBytes;
      if (pages > 2000) throw new Error("Paging stopped advancing.");
    }
    expect(pages).toBeGreaterThan(20);
    expect(restored).toBe(fs.readFileSync(logger.logPath, "utf8"));
    expect(restored).toContain(output);
  });

  it("rejects invalid IDs, workspace traversal and unsafe byte offsets", async () => {
    const logger = createCommandLog("workspace isolation test", workspace);
    temporaryLogs.push(logger.logPath);
    logger.write("private output");
    logger.end(0);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-other-"));
    try {
      await expect(readCommandOutputPage(logger.id, other)).rejects.toThrow("outside the authorized workspace");
      await expect(readCommandOutputPage("../secrets", workspace)).rejects.toThrow("Invalid commandId");
      await expect(readCommandOutputPage(logger.id, workspace, -1)).rejects.toThrow("offsetBytes");
      await expect(readCommandOutputPage(logger.id, workspace, 0, Number.NaN)).rejects.toThrow("maxBytes");
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("pages a CLI Bridge log with Unicode and returns stable resume cursors", async () => {
    const log = path.join(workspace, "delegate.log");
    const contents = ("🔍 " + "x".repeat(237) + "\n").repeat(110);
    fs.writeFileSync(log, contents, "utf8");
    let cursor = 0;
    let restored = "";
    let pageCount = 0;
    for (;;) {
      const page = await readCliLogPage(log, cursor, 273);
      restored += page.text;
      pageCount++;
      if (!page.hasMore) break;
      expect(page.nextOffsetBytes).toBeGreaterThan(cursor);
      cursor = page.nextOffsetBytes;
      if (pageCount > 1000) throw new Error("Paging stopped advancing.");
    }
    expect(pageCount).toBeGreaterThan(20);
    expect(restored).toBe(contents);
  });
});
