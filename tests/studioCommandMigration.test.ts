import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../src/core/commands/registry.js";
import { motionCommand } from "../src/core/commands/motionCommand.js";
import { STUDIO_SUGGESTIONS } from "../src/core/commands/commandCatalog.js";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";
import { MOTION_CAPABILITIES } from "../src/core/motion/motionCapabilities.js";
import type { ChatLine, SlashCommandContext } from "../src/core/commands/types.js";

afterEach(() => vi.restoreAllMocks());

describe("SuperAgent Studio command migration", () => {
  it("exposes /studio as the only discoverable slash entry point", () => {
    expect(registry.get("studio")).toBe(motionCommand);
    expect(registry.get("motion")).toBeUndefined();
    expect(motionCommand.name).toBe("studio");
    expect(motionCommand.description).toContain("SuperAgent Studio");
    expect(STUDIO_SUGGESTIONS).toContain("/studio generate");
    expect(STUDIO_SUGGESTIONS).toContain("/studio render");
    expect(STUDIO_SUGGESTIONS.every(value => value.startsWith("/studio "))).toBe(true);
    expect(MOTION_CAPABILITIES.productDisplayName).toBe("SuperAgent Studio");
  });

  it("prints new slash help and never advertises old /motion entry", async () => {
    const messages: ChatLine[] = [];
    const ctx = {
      addLine: (line: ChatLine) => messages.push(line),
      agent: null,
    } as SlashCommandContext;
    await motionCommand.execute("help", ctx);
    expect(messages[0].content).toContain("/studio render");
    expect(messages[0].content).toContain("/studio generate");
    expect(messages[0].content).not.toContain("/motion");
  });

  it("shows superagent studio CLI instructions for scripts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await handleMotionCliCommand(["help"])).toBe(0);
    const help = log.mock.calls.map(args => String(args[0])).join("\n");
    expect(help).toContain("superagent studio generate");
    expect(help).toContain("superagent studio render");
    expect(help).not.toContain("superagent motion ");
  });
});
