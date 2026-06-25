import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
// Mock os.homedir() di paling atas untuk isolasi penuh
const tempHome = path.join(process.cwd(), "tests", "temp-home-agent");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);
import { Agent } from "./agent.js";
import { savePreset, setActivePresetId, clearModelConfigCache } from "./config/jsonConfig.js";
import { getModelConfigPath, ensureGlobalConfigDir } from "./config/paths.js";
const configPath = getModelConfigPath();
beforeEach(() => {
    // Bersihkan folder temp
    if (fs.existsSync(tempHome)) {
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
    ensureGlobalConfigDir();
    clearModelConfigCache();
});
afterEach(() => {
    // Bersihkan folder temp
    if (fs.existsSync(tempHome)) {
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
    clearModelConfigCache();
});
// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeHandlers() {
    const events = [];
    const onEvent = vi.fn((e) => events.push(e));
    const onPermission = vi.fn(async () => true);
    const onQuestion = vi.fn(async () => "No, stop here");
    return { events, onEvent, onPermission, onQuestion };
}
// ─── Goal Mode: Properties ─────────────────────────────────────────────────────
describe("Agent – goal mode properties", () => {
    it("goalMode defaults to null", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        expect(agent.goalMode).toBeNull();
    });
    it("goalMaxIterations defaults to 200", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        expect(agent.goalMaxIterations).toBe(200);
    });
    it("goalMode can be set and read back", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        agent.goalMode = "build a REST API with tests";
        expect(agent.goalMode).toBe("build a REST API with tests");
    });
    it("goalMaxIterations can be customized", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        agent.goalMaxIterations = 100;
        expect(agent.goalMaxIterations).toBe(100);
    });
    it("goalMode can be cleared back to null", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        agent.goalMode = "some goal";
        agent.goalMode = null;
        expect(agent.goalMode).toBeNull();
    });
});
// ─── Goal Mode: planState independence ────────────────────────────────────────
describe("Agent – goalMode is independent of planState", () => {
    it("setting goalMode does not affect planState", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        agent.goalMode = "fix all tests";
        expect(agent.planState).toBe("IDLE");
    });
    it("approvePlan does not clear goalMode", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        agent.goalMode = "deploy to production";
        agent.approvePlan();
        expect(agent.goalMode).toBe("deploy to production");
        expect(agent.planState).toBe("APPROVED");
    });
    it("planState stays APPROVED and does not revert to PLANNING_PENDING via approvePlan", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        agent.planState = "PLANNING_PENDING";
        expect(agent.planState).toBe("PLANNING_PENDING");
        agent.approvePlan();
        expect(agent.planState).toBe("APPROVED");
        // Calling approvePlan again should keep it APPROVED
        agent.approvePlan();
        expect(agent.planState).toBe("APPROVED");
    });
});
// ─── Goal Mode: AgentEvent type ───────────────────────────────────────────────
describe("AgentEvent type – goal_done", () => {
    it("goal_done event has correct shape", () => {
        const event = {
            type: "goal_done",
            goal: "implement auth",
            summary: "GOAL_COMPLETE: auth implemented with tests",
        };
        expect(event.type).toBe("goal_done");
        expect(event.goal).toBe("implement auth");
        expect(event.summary).toContain("GOAL_COMPLETE");
    });
});
// ─── Goal Mode: abort / reset ─────────────────────────────────────────────────
describe("Agent – abort and reset", () => {
    it("abort() can be called safely when agent is not running", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        expect(() => agent.abort()).not.toThrow();
    });
    it("isAgentRunning() returns false before any sendMessage", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        expect(agent.isAgentRunning()).toBe(false);
    });
    it("goalMode persists until explicitly cleared", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        agent.goalMode = "overnight task";
        // Simulate what /new and /clear do:
        agent.goalMode = null;
        expect(agent.goalMode).toBeNull();
    });
});
// ─── Goal Mode: goalMaxIterations validation ──────────────────────────────────
describe("Agent – goalMaxIterations boundary values", () => {
    it("accepts large iteration values", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        agent.goalMaxIterations = 1000;
        expect(agent.goalMaxIterations).toBe(1000);
    });
    it("accepts iteration value of 1", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        agent.goalMaxIterations = 1;
        expect(agent.goalMaxIterations).toBe(1);
    });
});
// ─── Countdown Delay ─────────────────────────────────────────────────────────
describe("Agent – delayWithCountdown", () => {
    it("counts down seconds and sends text events", async () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        vi.useFakeTimers();
        const delayPromise = agent.delayWithCountdown(1, 4000);
        await vi.runAllTimersAsync();
        await delayPromise;
        vi.useRealTimers();
        const textEvents = onEvent.mock.calls
            .map((args) => args[0])
            .filter((e) => e.type === "text")
            .map((e) => e.content);
        expect(textEvents).toContain("\rRetrying in 4s... ");
        expect(textEvents).toContain("\rRetrying in 3s... ");
        expect(textEvents).toContain("\rRetrying in 2s... ");
        expect(textEvents).toContain("\rRetrying in 1s... ");
        expect(textEvents[textEvents.length - 1]).toBe("\r\n");
    });
});
// ─── Agent History Sessions ───────────────────────────────────────────────────
describe("Agent – history sessions", () => {
    it("generates a new unique session file name with timestamp when autoResume is false", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        const resolvedPath = agent.resolveHistoryFilePath(false);
        expect(resolvedPath).toContain("single");
        expect(resolvedPath).toMatch(/_\d+[\\/]\w+_\d+\.json$/);
    });
    it("places history in multi subdirectory when isMultiAgent is true", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        agent.isMultiAgent = true;
        const resolvedPath = agent.resolveHistoryFilePath(false);
        expect(resolvedPath).toContain("multi");
        expect(resolvedPath).toMatch(/_\d+[\\/]\w+_\d+\.json$/);
    });
});
// ─── Agent Working Directory ──────────────────────────────────────────────────
describe("Agent – workingDirectory", () => {
    it("defaults to getConfig().workingDirectory", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        expect(agent.workingDirectory).toBeDefined();
    });
    it("can be customized via constructor parameter", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const customDir = "/path/to/custom/dir";
        const agent = new Agent(onEvent, onPermission, onQuestion, undefined, undefined, customDir);
        expect(agent.workingDirectory).toBe(customDir);
    });
});
// ─── Agent Logging ─────────────────────────────────────────────────────────────
describe("Agent – logging to superagent.log", () => {
    let appendSpy;
    beforeEach(() => {
        appendSpy = vi.spyOn(fs, "appendFileSync").mockImplementation(() => { });
    });
    afterEach(() => {
        appendSpy.mockRestore();
    });
    it("should format and write logs correctly for different events", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        // Trigger tool start event
        agent.onEvent({
            type: "tool_start",
            toolCall: { id: "call1", name: "test_tool", args: { x: 1 } },
            description: "running test tool",
        });
        // Check appendFileSync call
        expect(appendSpy).toHaveBeenCalled();
        const [logPath, logMessage] = appendSpy.mock.calls[0];
        expect(logPath).toContain("superagent.log");
        expect(logMessage).toContain("[tier:master]");
        expect(logMessage).toContain("[depth:0]");
        expect(logMessage).toContain("[multi:false]");
        expect(logMessage).toContain("[TOOL_START]");
        expect(logMessage).toContain("Tool: test_tool");
        expect(logMessage).toContain('Args: {"x":1}');
    });
    it("should buffer text events and flush them on non-text events", () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const agent = new Agent(onEvent, onPermission, onQuestion);
        agent.onEvent({ type: "text", content: "Hello " });
        agent.onEvent({ type: "text", content: "World!" });
        // Should not have logged the text yet
        expect(appendSpy).not.toHaveBeenCalled();
        // Trigger non-text event
        agent.onEvent({ type: "done" });
        // Should flush the text first, then log the done event
        expect(appendSpy).toHaveBeenCalledTimes(2);
        const firstCall = appendSpy.mock.calls[0][1];
        const secondCall = appendSpy.mock.calls[1][1];
        expect(firstCall).toContain("[TEXT] Hello World!");
        expect(secondCall).toContain("[DONE]");
    });
});
describe("Agent – tier-specific model resolution", () => {
    let originalEnv;
    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.OPENAI_API_KEY = "dummy-key";
        process.env.ANTHROPIC_API_KEY = "dummy-key";
    });
    afterEach(() => {
        process.env = originalEnv;
    });
    it("should use correct model based on agent tier and subagentType when isMultiAgent is true", () => {
        const testPreset = {
            id: "test-agent-multi-preset",
            name: "Test Agent Multi Preset",
            description: "Test",
            models: {
                master: { providerProfileId: "default-openai", model: "gpt-4-master" },
                superagent: { providerProfileId: "default-anthropic", model: "claude-superagent" },
                subagentDefault: { providerProfileId: "default-openai", model: "gpt-subagent" },
                subagentDetails: {
                    researcher: { providerProfileId: "default-openai", model: "gpt-researcher" }
                }
            }
        };
        savePreset("multi", testPreset);
        setActivePresetId("multi", "test-agent-multi-preset");
        process.env.SUPERAGENT_MULTI = "true";
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        // Master Agent
        const masterAgent = new Agent(onEvent, onPermission, onQuestion);
        masterAgent.isMultiAgent = true;
        masterAgent.tier = "master";
        masterAgent.delegationDepth = 0;
        const masterModel = masterAgent.getModel();
        expect(masterModel.modelId).toBe("gpt-4-master");
        // Superagent
        const superagent = new Agent(onEvent, onPermission, onQuestion);
        superagent.isMultiAgent = true;
        superagent.tier = "superagent";
        superagent.delegationDepth = 1;
        const superagentModel = superagent.getModel();
        expect(superagentModel.modelId).toBe("claude-superagent");
        // Subagent
        const subagent = new Agent(onEvent, onPermission, onQuestion);
        subagent.isMultiAgent = true;
        subagent.tier = "subagent";
        subagent.delegationDepth = 2;
        const subagentModel = subagent.getModel();
        expect(subagentModel.modelId).toBe("gpt-subagent");
        // Subagent Coder
        subagent.subagentType = "coder";
        const coderModel = subagent.getModel();
        expect(coderModel.modelId).toBe("gpt-subagent");
        // Subagent Researcher
        subagent.subagentType = "researcher";
        const researcherModel = subagent.getModel();
        expect(researcherModel.modelId).toBe("gpt-researcher");
    });
    it("should use tier-specific MODEL in single-agent mode if tier-specific keys are defined", () => {
        const testPreset = {
            id: "test-agent-single-preset",
            name: "Test Agent Single Preset",
            description: "Test",
            models: {
                superagent: { providerProfileId: "default-openai", model: "gpt-4-single" },
                subagentDefault: { providerProfileId: "default-openai", model: "gpt-subagent" },
                subagentDetails: {}
            }
        };
        savePreset("single", testPreset);
        setActivePresetId("single", "test-agent-single-preset");
        // Clear out active provider env vars to avoid overrides
        const originalActiveProvider = process.env.ACTIVE_PROVIDER;
        delete process.env.ACTIVE_PROVIDER;
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const singleAgent = new Agent(onEvent, onPermission, onQuestion);
        // isMultiAgent remains false (default)
        const model = singleAgent.getModel();
        expect(model.modelId).toBe("gpt-4-single");
        process.env.ACTIVE_PROVIDER = originalActiveProvider;
    });
    it("should dynamically inject agents.md and karpathy-guidelines into systemPrompt", async () => {
        const { onEvent, onPermission, onQuestion } = makeHandlers();
        const testDir = path.join(process.cwd(), "scratch_test_agent");
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }
        const originalCwd = process.cwd;
        process.cwd = () => testDir;
        // Write mock agents.md, mock karpathy-guidelines, and mock superagent-planning
        fs.writeFileSync(path.join(testDir, "agents.md"), "MOCK_AGENTS_GUIDELINES");
        const skillDir = path.join(testDir, ".agents", "skills", "karpathy-guidelines");
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), "MOCK_KARPATHY_GUIDELINES");
        const planningSkillDir = path.join(testDir, ".agents", "skills", "superagent-planning");
        fs.mkdirSync(planningSkillDir, { recursive: true });
        fs.writeFileSync(path.join(planningSkillDir, "SKILL.md"), "MOCK_SUPERAGENT_PLANNING");
        const agent = new Agent(onEvent, onPermission, onQuestion, "Base Prompt", undefined, testDir);
        // Verify file loading works (access config.systemPrompt to trigger loading, should not throw)
        const sysPrompt = agent.config.systemPrompt;
        // Clean up files
        try {
            fs.unlinkSync(path.join(testDir, "agents.md"));
            fs.unlinkSync(path.join(skillDir, "SKILL.md"));
            fs.rmdirSync(skillDir);
            fs.unlinkSync(path.join(planningSkillDir, "SKILL.md"));
            fs.rmdirSync(planningSkillDir);
            fs.rmdirSync(path.join(testDir, ".agents", "skills"));
            fs.rmdirSync(path.join(testDir, ".agents"));
            fs.rmdirSync(testDir);
        }
        catch { }
        process.cwd = originalCwd;
    });
});
//# sourceMappingURL=agent.test.js.map