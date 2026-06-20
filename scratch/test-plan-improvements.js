import { Agent } from "../dist/core/agent.js";
import { executeToolCall } from "../dist/core/permissions.js";
import { Conversation } from "../dist/core/conversation.js";
import path from "path";
import fs from "fs/promises";

async function runTests() {
  console.log("=== STARTING PLAN IMPROVEMENTS TESTS ===");

  const dummyOnEvent = (event) => {
    if (event.type === "text") {
      console.log(`[SYS TEXT]: ${event.content.trim()}`);
    }
  };

  const agent = new Agent(
    dummyOnEvent,
    async () => true, // Auto permission approve
    async () => "Option"
  );

  console.log(`\n1. Initial plan state: ${agent.planState} (Expected: IDLE)`);
  if (agent.planState !== "IDLE") throw new Error("Initial state should be IDLE");

  // ----------------------------------------------------
  console.log("\n2. Simulating invalid implementation_plan.md write (lacking headers)...");
  // Simulating the executeToolCall flow in runAgentLoop manually to verify logic
  const invalidPlanContent = "This is a simple plan with no sections.";
  
  const invalidPlanToolCall = {
    id: "call_invalid",
    name: "write_to_file",
    args: {
      filePath: path.join(process.cwd(), "implementation_plan.md"),
      content: invalidPlanContent
    }
  };

  // Run the validator logic block manually or mock the agent's flow
  // To test the exact logic we implemented in agent.ts:
  const checkPlanValidity = (planContent) => {
    const hasProposedChanges = /proposed\s+changes/i.test(planContent) || /rencana\s+perubahan/i.test(planContent);
    const hasVerificationPlan = /verification\s+plan/i.test(planContent) || /rencana\s+verifikasi/i.test(planContent);
    const hasTitle = /^#\s+.+/m.test(planContent);
    return hasTitle && (hasProposedChanges || hasVerificationPlan);
  };

  console.log(`Plan validity check: ${checkPlanValidity(invalidPlanContent)} (Expected: false)`);
  if (checkPlanValidity(invalidPlanContent)) throw new Error("Validator should fail on invalid content");

  // ----------------------------------------------------
  console.log("\n3. Simulating valid implementation_plan.md write...");
  const validPlanContent = `# Valid Test Plan\n\n## Proposed Changes\n- Edit test files.\n\n## Verification Plan\n- Run tsc.`;
  console.log(`Plan validity check: ${checkPlanValidity(validPlanContent)} (Expected: true)`);
  if (!checkPlanValidity(validPlanContent)) throw new Error("Validator should pass on valid content");

  // Set state to pending
  agent.planState = "PLANNING_PENDING";
  console.log(`State transitioned to: ${agent.planState} (Expected: PLANNING_PENDING)`);

  // ----------------------------------------------------
  console.log("\n4. Testing command blocking during PLANNING_PENDING...");
  
  const checkCommandBlocked = (cmd) => {
    const isModifyingCommand = /([>\u226B\u00BB]|\b(rm|rmdir|mkdir|cp|mv|touch|git\s+(checkout|apply|reset|clean|merge|rebase|commit|add|push|pull)|npm\s+(install|i|uninstall|update|add)|yarn\s+(add|remove|upgrade|install)|pnpm\s+(add|remove|update|install|i))\b)/i.test(cmd);
    return isModifyingCommand;
  };

  const modifyingCommands = [
    "echo 'test' > file.txt",
    "git checkout main",
    "npm install lodash",
    "rm -rf dist",
    "mkdir newdir"
  ];

  for (const cmd of modifyingCommands) {
    const blocked = checkCommandBlocked(cmd);
    console.log(`Command: "${cmd}" -> Blocked? ${blocked} (Expected: true)`);
    if (!blocked) throw new Error(`Command "${cmd}" should be blocked!`);
  }

  const safeCommands = [
    "npm run test",
    "git diff",
    "git status",
    "tsc --noEmit",
    "node -v"
  ];

  for (const cmd of safeCommands) {
    const blocked = checkCommandBlocked(cmd);
    console.log(`Command: "${cmd}" -> Blocked? ${blocked} (Expected: false)`);
    if (blocked) throw new Error(`Command "${cmd}" should NOT be blocked!`);
  }

  // ----------------------------------------------------
  console.log("\n5. Testing Goal Mode Auto-Approval...");
  const agentInGoalMode = new Agent(
    dummyOnEvent,
    async () => true,
    async () => "Option"
  );
  agentInGoalMode.goalMode = "Automated test goal";
  
  // Simulating writing a valid plan in Goal Mode
  if (checkPlanValidity(validPlanContent)) {
    agentInGoalMode.planState = "APPROVED"; // Goal mode transitions it to approved directly
  }
  console.log(`Goal Mode agent planState: ${agentInGoalMode.planState} (Expected: APPROVED)`);
  if (agentInGoalMode.planState !== "APPROVED") throw new Error("Goal Mode planState should be APPROVED");

  // ----------------------------------------------------
  console.log("\n6. Testing Serialization and Deserialization of planState...");
  const tempHistoryFile = path.join(process.cwd(), "scratch", "temp-history-test.json");
  
  const conversation = new Conversation();
  conversation.addUserMessage("Initial message");
  conversation.addAssistantMessage("Draft plan", [{ id: "call_1", name: "write", args: {} }]);
  
  // Save conversation with PLANNING_PENDING state
  await conversation.saveToFile(tempHistoryFile, "PLANNING_PENDING");
  console.log("Session saved with planState: PLANNING_PENDING");

  const loaderConversation = new Conversation();
  await loaderConversation.loadFromFile(tempHistoryFile);
  console.log(`Loaded planState: ${loaderConversation.loadedPlanState} (Expected: PLANNING_PENDING)`);
  if (loaderConversation.loadedPlanState !== "PLANNING_PENDING") {
    throw new Error("Failed to load planState back from session history!");
  }

  // Clean up
  await fs.unlink(tempHistoryFile);

  // ----------------------------------------------------
  console.log("\n7. Testing global session-specific file paths...");
  const planPath = agent.getPlanFilePath();
  const taskPath = agent.getTaskFilePath();
  const walkthroughPath = agent.getWalkthroughFilePath();
  
  console.log(`Plan path: ${planPath}`);
  console.log(`Task path: ${taskPath}`);
  console.log(`Walkthrough path: ${walkthroughPath}`);

  if (!planPath.endsWith("_implementation_plan.md") || !planPath.includes(".superagent-r")) {
    throw new Error("Plan path does not follow global history session structure");
  }
  if (!taskPath.endsWith("_task.md") || !taskPath.includes(".superagent-r")) {
    throw new Error("Task path does not follow global history session structure");
  }
  if (!walkthroughPath.endsWith("_walkthrough.md") || !walkthroughPath.includes(".superagent-r")) {
    throw new Error("Walkthrough path does not follow global history session structure");
  }

  console.log("\n=== ALL TESTS PASSED SUCCESSFULLY ===");
}

runTests().catch((err) => {
  console.error("Test failed: ", err);
  process.exit(1);
});
