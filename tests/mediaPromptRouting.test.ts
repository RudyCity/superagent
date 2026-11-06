import { describe, expect, it } from "vitest";
import { Agent } from "../src/core/agent.js";
import { ContextBuilder } from "../src/core/agent/ContextBuilder.js";
import {
  CHROME_EXTENSION_SYSTEM_PROMPT,
  MASTER_AGENT_SYSTEM_PROMPT,
  SUBAGENT_SYSTEM_PROMPTS,
  SUPERAGENT_SYSTEM_PROMPT,
} from "../src/core/prompts.js";

const mediaRules = [
  "MEDIA_ROUTING",
  "MEDIA_COMPRESSION",
  "MEDIA_TRANSFORMS",
  "MEDIA_CONVERSIONS",
  "MEDIA_OUTPUT_GUARD",
] as const;

describe("media workflow guidance in tier prompts", () => {
  it("keeps the same actionable media policy across active Master and executor prompt exports", () => {
    const prompts = [
      MASTER_AGENT_SYSTEM_PROMPT,
      SUPERAGENT_SYSTEM_PROMPT("media-worker", "main", "authorized-workspace"),
      CHROME_EXTENSION_SYSTEM_PROMPT,
      SUBAGENT_SYSTEM_PROMPTS.coder,
      SUBAGENT_SYSTEM_PROMPTS.general,
    ];

    for (const prompt of prompts) {
      for (const label of mediaRules) expect(prompt).toContain(label);
      expect(prompt).toContain("media_capabilities/media_plan preflight");
      expect(prompt).toContain("operation:'compress'");
      expect(prompt).toContain("JPEG/WebP/AVIF quality");
      expect(prompt).toContain("targetKB/targetBytes ONLY when");
      expect(prompt).toContain("PNG may support lossless optimization");
      expect(prompt).toContain("not met");
      expect(prompt).toContain("remove_background");
      expect(prompt).toContain("transparent PNG");
      expect(prompt).toContain("rembg");
      expect(prompt).toContain("upscale_ai");
      expect(prompt).toContain("Real-ESRGAN");
      expect(prompt).toContain("resize/crop/rotate/watermark");
      expect(prompt).toContain("DOCX/XLSX/PPTX");
      expect(prompt).toContain("create-only");
      expect(prompt).toContain("byte size/hash and backend");
      expect(prompt).toContain("No hardcoded user response or fabricated completion");
    }
  });

  it("does not direct read-only research agents to execute media writes", () => {
    expect(SUBAGENT_SYSTEM_PROMPTS.researcher).not.toContain("MEDIA_COMPRESSION");
    expect(SUBAGENT_SYSTEM_PROMPTS.researcher).toContain("Read-only");
  });

  it("places the media policy in the real assembled Master system message", async () => {
    const agent = new Agent(
      () => undefined,
      async () => false,
      async () => "",
      MASTER_AGENT_SYSTEM_PROMPT,
      [],
      process.cwd(),
    );
    agent.tier = "master";
    agent.isMultiAgent = true;
    agent.disableWorkspaceDiscovery = true;
    agent.getHistory().addUserMessage("Compress a local photo to a new WebP under 150 KB");

    try {
      const runtime = await ContextBuilder.buildContext(agent);
      for (const label of mediaRules) expect(runtime.finalSystemPrompt).toContain(label);
      expect(runtime.finalSystemPrompt).toContain("media_capabilities/media_plan preflight");
      expect(runtime.finalSystemPrompt).toContain("No hardcoded user response or fabricated completion");
      expect(runtime.messages.some(message => message.role === "user")).toBe(true);
    } finally {
      agent.dispose();
    }
  });
});
