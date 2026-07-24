import { generateText } from "ai";
import { getSettings, getModelInstanceForTier } from "../config.js";
import { allTasksCompleted, archiveCompletedTasks } from "../taskChecklist.js";
import { captureGitSnapshot } from "./GitUtils.js";
import { contentToString } from "../conversation.js";
import type { Agent } from "../agent.js";

export class RequestProcessor {
  public static async processRequest(
    agent: Agent,
    userInput: string | import("../conversation.js").MessageContent
  ): Promise<boolean> {
    const currentCwd = (agent.tier === "superagent" && agent.worktreePath)
      ? agent.worktreePath
      : agent.workingDirectory;
    (agent as any).gitStartSnapshot = await captureGitSnapshot(currentCwd);

    const isTestEnv = process.env.VITEST && process.env.SUPERAGENT_TEST_SIMPLE_TASK !== "true";
    if (!isTestEnv) {
      try {
        const settings = getSettings();
        const { classifyHeuristic } = await import("../requestClassifier.js");
        const textInput = typeof userInput === "string"
          ? userInput
          : (userInput as any[]).map((p: any) => p.type === "text" ? p.text : "").join(" ");
        const heuristicResult = classifyHeuristic(textInput, settings.classifierKeywords as any);
        
        if (settings.classifierEnabled !== false) {
          const { classifyRequest } = await import("../requestClassifier.js");
          const classifierModel = getModelInstanceForTier("subagent", 2, "classifier", !agent.isMultiAgent);
          const classification = await classifyRequest(userInput, classifierModel, {
            confidenceThreshold: settings.classifierConfidenceThreshold ?? "high",
            customKeywords: settings.classifierKeywords as any,
            skipLLM: agent.planState !== "IDLE",
          });
          agent.currentClassification = classification;
          agent.writeToLogFile("INFO", `Request classified: category=${classification.category}, confidence=${classification.confidence}, heuristicOnly=${classification.heuristicOnly}, tokens=${classification.classificationTokens}, reason=${classification.reason}`);

          if (!classification.heuristicOnly && classification.classificationTokens > 0) {
            try {
              const { addMasterTokens } = await import("../tools/state.js");
              addMasterTokens(classification.classificationTokens, 0);
            } catch {}
          }

          if (agent.planState === "IDLE") {
            const skipPlanningCategories = ["conversation", "question", "research"];
            if (skipPlanningCategories.includes(classification.category)) {
              agent.isSimpleTask = true;
              agent.planState = "APPROVED";
              agent.simpleTaskApproved = true;
            } else if (classification.category === "complex_task") {
              const userInputText = typeof userInput === "string" ? userInput : (userInput as any[]).map((p: any) => p.type === "text" ? p.text : "").join(" ");
              const lowerInput = userInputText.toLowerCase();
              const isPlanRequest = /plan|design|architecture/i.test(lowerInput);
              if (isPlanRequest) {
                agent.isSimpleTask = false;
              } else {
                const isComplex = /refactor|rewrite|architecture|design|feature|migration|oauth|database|schema|multi-file/i.test(lowerInput) || lowerInput.split(/\s+/).length > 25;
                if (isComplex) {
                  agent.isSimpleTask = false;
                } else {
                  agent.isSimpleTask = true;
                  agent.planState = "APPROVED";
                  agent.simpleTaskApproved = true;
                }
              }
            } else if (classification.category === "simple_edit" || classification.category === "command" || classification.category === "debug") {
              agent.isSimpleTask = true;
              agent.planState = "APPROVED";
              agent.simpleTaskApproved = true;
            }
          }
        } else {
          if (heuristicResult.category === "conversation") {
            agent.currentClassification = heuristicResult;
            agent.writeToLogFile("INFO", `Heuristic fallback detected conversation: ${heuristicResult.reason}`);
          }

          if (agent.planState === "IDLE") {
            if (agent.currentClassification?.category === "conversation") {
              agent.isSimpleTask = true;
              agent.planState = "APPROVED";
              agent.simpleTaskApproved = true;
            } else {
              const model = agent.getModel();
              const threshold = settings.simpleTaskFileThreshold ?? 3;
              const classificationPrompt = `You are a helper that classifies if a user request is a "simple task" or a general chat/conversation.
  Reply with "chat" if the request is a general greeting, discussion/conversation, or simple question/acknowledgment that does not require executing tools or making code changes.
  Reply with "yes" if it is a simple task that expects modification or creation of fewer than ${threshold} files and does NOT introduce any new architecture, major system changes, or complex orchestration (e.g. simple refactoring, adding a simple helper, fixing a simple bug).
  Reply with "no" if it is a complex task requiring extensive work, multiple files, or planning.

  User request: "${userInput}"

  Reply with EXACTLY "chat", "yes", or "no". Reply with nothing else.`;

              const response = await generateText({
                model,
                prompt: classificationPrompt,
              });

              try {
                const { addMasterTokens } = await import("../tools/state.js");
                addMasterTokens(response.usage?.promptTokens || 0, response.usage?.completionTokens || 0);
              } catch {}

              const classification = response.text.trim().toLowerCase();
              if (classification === "chat" || classification.includes("chat")) {
                agent.currentClassification = {
                  category: "conversation",
                  confidence: "medium",
                  reason: "Legacy fallback classified as chat/conversation",
                  heuristicOnly: false,
                  classificationTokens: (response.usage?.promptTokens || 0) + (response.usage?.completionTokens || 0),
                };
                agent.isSimpleTask = true;
                agent.planState = "APPROVED";
                agent.simpleTaskApproved = true;
              } else if (classification === "yes" || classification.includes("yes")) {
                agent.isSimpleTask = true;
                agent.planState = "APPROVED";

                const userInputText = typeof userInput === "string" ? userInput : (userInput as any[]).map((p: any) => p.type === "text" ? p.text : "").join(" ");
                const lowerInput = userInputText.toLowerCase();
                const words = lowerInput.split(/[^a-zA-Z0-9'']+/).filter(Boolean);
                const preApprovalWords = settings.simpleTaskKeywords || ['lanjut', 'coba', 'go ahead', 'proceed', 'try', 'run', 'execute', 'ok', 'yes', 'y'];
                const hasPreApproval = preApprovalWords.some(word => {
                  if (word.includes(' ')) {
                    return lowerInput.includes(word);
                  }
                  return words.some(w => w === word || (word.length >= 4 && w.startsWith(word)));
                });
                if (hasPreApproval) {
                  agent.simpleTaskApproved = true;
                }
              }
            }
          }
        }
      } catch (err: any) {
        agent.writeToLogFile("WARN", `Failed to classify user request: ${err.message}`);
        agent.onEvent({ type: "text", content: `[SYS] Warning: Request classification issue (${err.message}). Falling back to main agent loop...\n\n` });
      }
    }

    if (agent.currentClassification) {
      try {
        const { isHighConfidenceConversation } = await import("../requestClassifier.js");
        if (isHighConfidenceConversation(agent.currentClassification, agent.tier)) {
          agent.writeToLogFile("INFO", `Conversation fast-path activated (category=conversation, confidence=high)`);
          const { FastPath } = await import("./FastPath.js");
          await FastPath.runConversationFastPath(agent, userInput);
          return false;
        }
      } catch (err: any) {
        agent.writeToLogFile("WARN", `Conversation fast-path check failed, falling through to agent loop: ${err.message}`);
      }
    }

    agent.writeToLogFile("INFO", `Agent execution started (tier: ${agent.tier}, depth: ${agent.delegationDepth}, isMultiAgent: ${agent.isMultiAgent}, workingDirectory: ${agent.workingDirectory}, worktreePath: ${agent.worktreePath})`);
    agent.writeToLogFile("USER", typeof userInput === "string" ? userInput : "[multimodal message]");

    agent.conversation.addUserMessage(userInput);
    await agent.compactHistoryIfNeeded();
    await agent.saveHistory();

    agent.autoCheckpoint("User message");

    (agent as any).tasksJustArchived = false;
    (agent as any).archivedTaskCount = 0;
    if (agent.planState === "APPROVED") {
      try {
        const taskPath = agent.getTaskFilePath();
        const allDone = await allTasksCompleted(taskPath);
        if (allDone) {
          const archived = await archiveCompletedTasks(taskPath);
          if (archived.length > 0) {
            (agent as any).tasksJustArchived = true;
            (agent as any).archivedTaskCount = archived.length;
            agent.writeToLogFile("INFO", `Auto-archived ${archived.length} completed tasks to history. Ready for new task creation.`);
          }
        }
      } catch (err: any) {
        agent.writeToLogFile("WARN", `Failed to auto-archive completed tasks: ${err.message}`);
      }
    }

    return true;
  }
}
