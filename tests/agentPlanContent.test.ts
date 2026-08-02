import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const tempHome = path.join(process.cwd(), "tests", "temp-home-plancontent");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { Agent } from "../src/core/agent.js";
import { clearModelConfigCache, clearSessionActivePreset } from "../src/core/config.js";
import { ensureGlobalConfigDir } from "../src/core/config/paths.js";

beforeEach(() => {
  if (fs.existsSync(tempHome)) fs.rmSync(tempHome, { recursive: true, force: true });
  fs.mkdirSync(tempHome, { recursive: true });
  ensureGlobalConfigDir();
  clearModelConfigCache();
  clearSessionActivePreset();
});

afterEach(() => {
  if (fs.existsSync(tempHome)) fs.rmSync(tempHome, { recursive: true, force: true });
  clearModelConfigCache();
  clearSessionActivePreset();
  vi.restoreAllMocks();
});

function makeHandlers() {
  const onEvent = vi.fn();
  const onPermission = vi.fn(async () => true);
  const onQuestion = vi.fn(async () => "No, stop here");
  return { onEvent, onPermission, onQuestion };
}

describe("Agent.hasRealPlanContent — nudge-loop guard", () => {
  it("returns false when plan file does not exist", () => {
    const { onEvent, onPermission, onQuestion } = makeHandlers();
    const agent = new Agent(onEvent, onPermission, onQuestion);
    const missing = path.join(tempHome, "does-not-exist.md");
    vi.spyOn(agent, "getPlanFilePath").mockReturnValue(missing);
    expect(agent.hasRealPlanContent()).toBe(false);
  });

  it("returns false for an empty or stub-only plan file", () => {
    const { onEvent, onPermission, onQuestion } = makeHandlers();
    const agent = new Agent(onEvent, onPermission, onQuestion);
    const stub = path.join(tempHome, "plan-empty.md");
    fs.writeFileSync(stub, "# Implementation Plan", "utf-8");
    vi.spyOn(agent, "getPlanFilePath").mockReturnValue(stub);
    expect(agent.hasRealPlanContent()).toBe(false);
  });

  it("returns true for a substantive plan file", () => {
    const { onEvent, onPermission, onQuestion } = makeHandlers();
    const agent = new Agent(onEvent, onPermission, onQuestion);
    const real = path.join(tempHome, "plan-real.md");
    fs.writeFileSync(
      real,
      "# Implementation Plan\n\n## Phase 1\n- Implement the nudge loop guard feature\n- Add regression tests\n",
      "utf-8"
    );
    vi.spyOn(agent, "getPlanFilePath").mockReturnValue(real);
    expect(agent.hasRealPlanContent()).toBe(true);
  });

  it("planState APPROVED alone does NOT imply real plan content (loop root cause)", () => {
    const { onEvent, onPermission, onQuestion } = makeHandlers();
    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.planState = "APPROVED";
    expect(agent.planState).toBe("APPROVED");
    const missing = path.join(tempHome, "no-plan.md");
    vi.spyOn(agent, "getPlanFilePath").mockReturnValue(missing);
    expect(agent.hasRealPlanContent()).toBe(false);
  });
});
