import { describe, it, expect } from "vitest";
import { cleanAssistantResponse } from "../src/utils/text.js";
import { Conversation } from "../src/core/conversation.js";

describe("cleanAssistantResponse", () => {
  it("should strip single echoed instruction prefix", () => {
    const input = `Proceed to step-by-step coding and execution! Keep implementation plans and tasks in sync. Make sure to update task statuses as you complete items. Write a walkthrough when done.
Actual response starts here.`;
    expect(cleanAssistantResponse(input)).toBe("Actual response starts here.");
  });

  it("should strip multiple echoed instruction prefixes and separators", () => {
    const input = `Proceed to step-by-step coding and execution! Keep implementation plans and tasks in sync. Make sure to update task statuses as you complete items. Write a walkthrough when done.
- Do NOT perform planning steps (no get_skills/use_skill calls or plan/task modifications for planning).
- Do NOT ask for permission/confirmation to make changes or run tests.
- Proceed directly to execution.
--------------------------------------------------
This is the actual user-facing assistant response.`;
    expect(cleanAssistantResponse(input)).toBe("This is the actual user-facing assistant response.");
  });

  it("should handle custom separator lines and extra whitespaces", () => {
    const input = `
==================================================

- Do NOT perform planning steps (no get_skills/use_skill calls or plan/task modifications for planning).
- Do NOT ask for permission/confirmation to make changes or run tests.
- Proceed directly to execution.

--------------------------------------------------

Wait, let me start coding.`;
    expect(cleanAssistantResponse(input)).toBe("Wait, let me start coding.");
  });

  it("should leave unrelated responses completely untouched", () => {
    const input = "Hello, how can I help you today?";
    expect(cleanAssistantResponse(input)).toBe("Hello, how can I help you today?");
  });

  it("should strip user's specific dynamic context instruction block", () => {
    const input = `DO NOT ask for further plan or design approvals. Proceed directly with implementing code changes, building/compiling, and running tests. Run validation commands (build/test) and record results in the Walkthrough File before completion. Do not wait for further user approval on edits. You do not need to ask for permission again unless there is an unexpected architecture-altering error or critical blocker. Make sure to update task statuses as you complete items, and write a walkthrough when done.

Proceed to next step.

---
Clean output.`;
    expect(cleanAssistantResponse(input)).toBe("Clean output.");
  });

  it("should clean assistant response when added to conversation", async () => {
    const convo = new Conversation({
      id: "test-convo-id",
      workingDirectory: process.cwd(),
    });
    
    convo.addAssistantMessage(`Proceed to step-by-step coding and execution! Keep implementation plans and tasks in sync. Make sure to update task statuses as you complete items. Write a walkthrough when done.
Everything is configured.`);
    
    const messages = convo.getMessages();
    const assistantMsg = messages.find(m => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.content).toBe("Everything is configured.");
  });
});
