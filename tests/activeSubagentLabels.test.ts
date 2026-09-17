import React from "react";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";

vi.unmock("react");
vi.unmock("ink");

const state = vi.hoisted(() => ({
  subagentInstances: new Map(),
  superagentInstances: new Map(),
  backgroundTasks: new Map(),
}));
vi.mock("../src/core/tools.js", () => ({ ...state, isTaskInWorkspace: () => true }));

import { ActiveAgentsList } from "../src/components/active-agents-list.js";
import { ActiveSubagentsPanel } from "../src/components/dashboard/active-subagents-panel.js";

const cleanups: Array<() => void> = [];
beforeEach(() => state.subagentInstances.clear());
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  state.subagentInstances.clear();
});

async function output(element: React.ReactElement, columns = 240) {
  const stdout = new PassThrough();
  Object.assign(stdout, { columns, isTTY: false });
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  let text = "";
  stdout.on("data", (chunk) => { text += chunk.toString(); });
  const app = render(element, {
    stdout: stdout as NodeJS.WriteStream,
    stdin: stdin as NodeJS.ReadStream,
    stderr: stderr as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  cleanups.push(() => {
    app.unmount();
    app.cleanup();
    stdout.destroy();
    stdin.destroy();
    stderr.destroy();
  });
  await vi.waitFor(() => expect(text).toContain("ACTIVE SUBAGENTS"));
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function agent(id: string, typeName: string, status = "running") {
  return { id, typeName, role: "Inspect labels", status, logs: [], prompt: "Review panel" };
}

const views = {
  list: (offset = 0, limit = 5) => React.createElement(ActiveAgentsList, {
    focusMode: "subagents", runningSuperagentsCount: 0,
    runningSubagentsCount: 2, runningTasksCount: 0,
    superagentsScrollOffset: 0, subagentsScrollOffset: offset, procsScrollOffset: 0,
    maxSuperagentsVisible: 5, maxSubagentsVisible: limit, maxProcsVisible: 5,
    collapsedSections: { superagents: false, subagents: false, procs: false },
  }),
  dashboard: (offset = 0, limit = 5) => React.createElement(ActiveSubagentsPanel, {
    subagentInstances: state.subagentInstances, agentsScrollOffset: offset,
    maxAgentsVisible: limit, focusArea: "agents",
    getLatestSubagentAction: () => "Review panel",
  }),
};

for (const [name, view] of Object.entries(views)) {
  describe(`${name} subagent labels`, () => {
    it.each(["researcher", "custom-auditor"])("shows %s type alongside role and action", async (type) => {
      state.subagentInstances.set("a1", agent("a1", type));
      const text = await output(view());
      expect(text).toContain(`a1 | Type: ${type} | Role: Inspect labels (running) | Action:`);
      expect(text).toContain("Review panel");
    });

    it("preserves filtering and scroll selection", async () => {
      state.subagentInstances.set("done", agent("done", "finished-type", "completed"));
      state.subagentInstances.set("a1", agent("a1", "researcher"));
      state.subagentInstances.set("a2", agent("a2", "custom-auditor"));
      const text = await output(view(1, 1));
      expect(text).toContain("a2 | Type: custom-auditor | Role: Inspect labels");
      expect(text).not.toContain("Type: researcher");
      expect(text).not.toContain("finished-type");
    });

    it("keeps type visible before a long action on a narrow terminal", async () => {
      state.subagentInstances.set("a1", { ...agent("a1", "coder"), prompt: `${"Review ".repeat(100)}ACTION_END_MARKER` });
      const text = await output(view(), 200);
      expect(text).toContain("Type: coder | Role: Inspect labels (running) | Action:");
      expect(text).not.toContain("ACTION_END_MARKER");
    });
  });
}
