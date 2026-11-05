import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { mediaConvert } from "../src/core/media/mediaEngine.js";
import { mediaPlan } from "../src/core/media/mediaPlanner.js";
import { MEDIA_MCP_TOOL_CLASSIFICATIONS, MEDIA_MCP_TOOL_DEFS } from "../src/core/mcp/tools/mediaMcpTools.js";
import { getProjectCapabilityForTool } from "../src/core/project/projectAccessPolicy.js";

const roots: string[] = [];
async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-media-plan-"));
  roots.push(cwd);
  await sharp({ create: { width: 24, height: 12, channels: 4, background: "#ff9800" } })
    .png().toFile(path.join(cwd, "sample.png"));
  return cwd;
}
afterAll(async () => {
  await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }).catch(() => {})));
});
describe("Read-only media route planning", () => {
  it("discovers a supported image-to-PDF route without creating a file", async () => {
    const cwd = await fixture();
    const plan = await mediaPlan({ inputPath: "sample.png", outputPath: "catalog.pdf" }, cwd);
    expect(plan.status).toBe("ok");
    expect(plan.supported).toBe(true);
    expect(plan.ready).toBe(true);
    expect(plan.backend).toContain("pdf-lib");
    expect(plan.fidelity).toBe("lossless_visual");
    expect(plan.noFileCreated).toBe(true);
    await expect(fs.stat(path.join(cwd, "catalog.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("recognizes XLSX-to-CSV after a real CSV-to-XLSX conversion", async () => {
    const cwd = await fixture();
    await fs.writeFile(path.join(cwd, "prices.csv"), "Product,Price\nCoffee,10\n");
    const created = await mediaConvert({ inputPath: "prices.csv", outputPath: "prices.xlsx" }, cwd);
    expect(created.status).toBe("ok");
    const plan = await mediaPlan({ inputPath: "prices.xlsx", outputPath: "prices-out.csv" }, cwd);
    expect(plan.status).toBe("ok");
    expect(plan.backend).toBe("@e965/xlsx");
    expect(plan.warnings).toContain("Only the first worksheet is exported as delimited text.");
  });
  it("reports unavailable or unsupported conversions instead of guessing", async () => {
    const cwd = await fixture();
    const noRoute = await mediaPlan({ inputPath: "sample.png", outputPath: "export.exe" }, cwd);
    expect(noRoute.status).toBe("failed");
    expect(noRoute.code).toBe("unsupported_conversion");
    expect(noRoute.supported).toBe(false);
  });
  it("plans local AI background removal with truthful model readiness", async () => {
    const cwd = await fixture();
    const plan = await mediaPlan({
      inputPath: "sample.png", outputPath: "transparent.png", mode: "transform",
      operation: "remove_background",
    }, cwd);
    expect(plan.status).toBe("ok");
    expect(plan.backend).toBe("rembg");
    expect(plan.requiredBackends).toContain("rembg_model_u2netp");
  });
  it("fails preflight for missing watermark artwork without creating files", async () => {
    const cwd = await fixture();
    const plan = await mediaPlan({ mode: "transform", operation: "watermark",
      inputPath: "sample.png", outputPath: "marked.png" }, cwd);
    expect(plan.status).toBe("failed");
    expect(plan.code).toBe("invalid_argument");
    await expect(fs.stat(path.join(cwd, "marked.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects unknown planner modes instead of silently converting", async () => {
    const cwd = await fixture();
    const plan = await mediaPlan({ mode: "delete", inputPath: "sample.png", outputPath: "out.pdf" }, cwd);
    expect(plan.status).toBe("failed");
    expect(plan.code).toBe("invalid_argument");
  });
  it("is explicitly safe in the MCP registry and uses project read capability", () => {
    expect(MEDIA_MCP_TOOL_DEFS.some(item => item.name === "superagent_media_plan")).toBe(true);
    expect(MEDIA_MCP_TOOL_CLASSIFICATIONS.superagent_media_plan).toBe("safe");
    expect(getProjectCapabilityForTool("superagent_media_plan")).toBe("read");
  });
});
