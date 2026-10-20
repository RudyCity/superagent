import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registry } from "../src/core/commands/registry.js";
import { motionCommand } from "../src/core/commands/motionCommand.js";
import type { SlashCommandContext, ChatLine } from "../src/core/commands/types.js";

const workspaces: string[] = [];
async function context() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-slash-test-"));
  workspaces.push(root);
  const messages: ChatLine[] = [];
  const ctx = {
    addLine: (entry: ChatLine) => messages.push(entry),
    agent: { workingDirectory: root },
  } as unknown as SlashCommandContext;
  return { ctx, messages, root };
}
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Interactive Motion Studio slash command", () => {
  it("registers a discoverable command and operates on the active workspace", async () => {
    expect(registry.get("motion")).toBe(motionCommand);
    const { ctx, messages, root } = await context();
    await motionCommand.execute("new Example Product Launch", ctx);
    expect(messages[0].content).toContain("Created motion project");
    const id = messages[0].content.match(/motion-[0-9a-f]{20}/)?.[0];
    expect(id).toBeDefined();
    await motionCommand.execute("list", ctx);
    expect(messages[1].content).toContain(id);
    await motionCommand.execute("edit " + id + " 1 title Better launch title", ctx);
    expect(messages[2].content).toContain("revision 2");
    await motionCommand.execute("frame " + id + " 24", ctx);
    expect(messages[3].content).toContain("Motion SVG preview:");
    const entries = await fs.readdir(path.join(root, ".superagent", "motion", "previews"));
    expect(entries).toHaveLength(1);
  });

  it("returns actionable usage and does not mutate projects for invalid input", async () => {
    const { ctx, messages } = await context();
    await motionCommand.execute("help", ctx);
    await motionCommand.execute("edit missing 0 title", ctx);
    expect(messages[0].content).toContain("/motion render");
    expect(messages[1].type).toBe("error");
    expect(messages[1].content).toContain("Usage");
    await motionCommand.execute("jobs", ctx);
    expect(messages[2].content).toContain("No motion render jobs");
  });
});
