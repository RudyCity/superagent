import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleSkillRoutes } from "../src/core/skills/skillRoutes.js";
import { createSkillCandidate } from "../src/core/skills/skillLifecycle.js";
import type { ExtractedWorkflowPatterns } from "../src/core/skills/synthesizerTypes.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-skill-routes-"));
const patterns: ExtractedWorkflowPatterns = { toolsUsed: [], commandPatterns: [], recoveredErrors: [], keySteps: [] };
const markdown = (name: string) => [
  "---", "name: " + name, "description: route candidate test", "category: testing", "---",
  "", "# Route Candidate", "", "## When to Use", "Use for route tests.", "",
  "## Step-by-Step Workflow", "1. Inspect the workspace.", "", "## Verification Protocol",
  "Run tests.", "",
].join(String.fromCharCode(10));

function routeContext(workspace: string | null, body = "{}") {
  const sent: Array<{ status: number; data: any }> = [];
  return {
    sent,
    ctx: {
      sendJSON: (_res: any, status: number, data: any) => sent.push({ status, data }),
      readBody: vi.fn(async () => body),
      resolveWorkspacePath: vi.fn(() => workspace),
    },
  };
}

afterEach(() => {
  // Per-test workspaces are removed by each test. The shared test root is retained
  // for this worker because the suite may be running concurrently.
});

describe("skill candidate HTTP routes", () => {
  it("lists candidates only from the workspace resolved by trusted request context", async () => {
    const trusted = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, "trusted-")));
    const other = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, "other-")));
    await createSkillCandidate(trusted, {
      name: "trusted-route-candidate", description: "trusted", category: "testing",
      markdownContent: markdown("trusted-route-candidate"), extractedPatterns: patterns,
    });
    await createSkillCandidate(other, {
      name: "other-route-candidate", description: "other", category: "testing",
      markdownContent: markdown("other-route-candidate"), extractedPatterns: patterns,
    });

    const { sent, ctx } = routeContext(trusted);
    const req = { method: "GET", headers: { "x-workspace-path": other } } as any;
    const handled = await handleSkillRoutes(req, {} as any, "/api/skills/candidates",
      new URL("http://localhost/api/skills/candidates?workspace=" + encodeURIComponent(other)), ctx);

    expect(handled).toBe(true);
    expect(sent[0].status).toBe(200);
    expect(sent[0].data.candidates.map((item: any) => item.name)).toEqual(["trusted-route-candidate"]);
    expect(ctx.resolveWorkspacePath).toHaveBeenCalledWith(req);
  });

  it("rejects an explicit workspace path when request context does not authorize it", async () => {
    const other = path.join(tempRoot, "unauthorized");
    const { sent } = routeContext(null);
    const ctx = routeContext(null);
    const req = { method: "GET", headers: { "x-workspace-path": other } } as any;
    await handleSkillRoutes(req, {} as any, "/api/skills/candidates",
      new URL("http://localhost/api/skills/candidates"), ctx.ctx);
    expect(ctx.sent[0]).toMatchObject({ status: 400, data: { error: "Invalid or unauthorized workspace path" } });
  });

  it("ignores an untrusted workspace supplied in the synthesis request body", async () => {
    const trusted = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, "synthesis-trusted-")));
    const other = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, "synthesis-other-")));
    const { sent, ctx } = routeContext(trusted, JSON.stringify({
      taskDescription: "Test route workspace boundaries",
      skillName: "route-boundary-helper",
      workspace: other,
    }));
    const req = { method: "POST", headers: {} } as any;
    const handled = await handleSkillRoutes(req, {} as any, "/api/skills/synthesize",
      new URL("http://localhost/api/skills/synthesize"), ctx);

    expect(handled).toBe(true);
    expect(sent[0].status).toBe(201);
    expect(sent[0].data.skill.filePath.startsWith(trusted)).toBe(true);
    expect(sent[0].data.skill.filePath.startsWith(other)).toBe(false);
    expect(fs.existsSync(path.join(trusted, ".superagent", "skill-candidates", "route-boundary-helper"))).toBe(true);
    expect(fs.existsSync(path.join(other, ".superagent", "skill-candidates", "route-boundary-helper"))).toBe(false);
  });
});
