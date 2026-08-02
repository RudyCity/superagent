import { generateText } from "ai";
import { getSettings, getModelInstanceForTier } from "../config.js";
import { allTasksCompleted, archiveCompletedTasks } from "../taskChecklist.js";
import { captureGitSnapshot } from "./GitUtils.js";
import { contentToString } from "../conversation.js";
import type { Agent } from "../agent.js";

import { analyzePromptIntent, translationBadgeEmitter, initONNXTranslationPipeline } from "../promptClarification.js";

export class RequestProcessor {
  public static async processRequest(
    agent: Agent,
    userInput: string | import("../conversation.js").MessageContent
  ): Promise<boolean> {
    const currentCwd = (agent.tier === "superagent" && agent.worktreePath)
      ? agent.worktreePath
      : agent.workingDirectory;
    (agent as any).gitStartSnapshot = await captureGitSnapshot(currentCwd);

    // Warm up lightweight local ONNX translation pipeline (<100MB RAM) in background
    initONNXTranslationPipeline().catch(() => {});

    const onBadge = (badge: any) => {
      agent.writeToLogFile("INFO", `[🌐 Desktop Badge UI] [${badge.detectedLanguage.toUpperCase()}] "${badge.originalPrompt}" -> "${badge.translatedPrompt}"`);
      if (typeof (agent as any).emit === "function") {
        (agent as any).emit("translationBadge", badge);
      }
    };
    translationBadgeEmitter.once("badge", onBadge);

    const isTestEnv = process.env.VITEST && process.env.SUPERAGENT_TEST_SIMPLE_TASK !== "true";
    if (!isTestEnv) {
      const settings = getSettings();
      const { classifyHeuristic } = await import("../requestClassifier.js");
      const textInput = typeof userInput === "string"
        ? userInput
        : (userInput as any[]).map((p: any) => p.type === "text" ? p.text : "").join(" ");
      // Heuristic is computed outside try so catch can use it as silent fallback
      const heuristicResult = classifyHeuristic(textInput, settings.classifierKeywords as any);

      const messages = agent.conversation.getMessages();
      const hasToolCalls = messages.some(m => m.role === "tool" || (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0));
      const lowerInput = textInput.toLowerCase().trim();
      const words = lowerInput.split(/[^a-zA-Z0-9'']+/).filter(Boolean);
      const preApprovalWords = settings.simpleTaskKeywords || ['lanjut', 'coba', 'go ahead', 'proceed', 'try', 'run', 'execute', 'ok', 'yes', 'y'];
      const isContinuation = preApprovalWords.some(word => {
        if (word.includes(' ')) {
          return lowerInput.includes(word);
        }
        return words.some(w => w === word || (word.length >= 4 && w.startsWith(word)));
      });

      if (hasToolCalls && isContinuation) {
        const classification = {
          category: "complex_task" as const,
          confidence: "high" as const,
          reason: "User requested continuation of task; bypassed classification to allow full toolset",
          heuristicOnly: true,
          classificationTokens: 0,
        };
        agent.currentClassification = classification;
        agent.writeToLogFile("INFO", `Request classified (continuation): category=${classification.category}, confidence=${classification.confidence}, reason=${classification.reason}`);
        
        agent.isSimpleTask = true;
        if (agent.planState === "IDLE") {
          agent.planState = agent.hasRealPlanContent() ? "APPROVED" : "IDLE";
        }
        agent.simpleTaskApproved = true;
      } else {
        try {
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
                agent.planState = agent.hasRealPlanContent() ? "APPROVED" : "IDLE";
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
                    agent.planState = agent.hasRealPlanContent() ? "APPROVED" : "IDLE";
                    agent.simpleTaskApproved = true;
                  }
                }
              } else if (classification.category === "simple_edit" || classification.category === "command" || classification.category === "debug") {
                agent.isSimpleTask = true;
                agent.planState = agent.hasRealPlanContent() ? "APPROVED" : "IDLE";
                agent.simpleTaskApproved = true;
              }
            } else if (agent.planState === "PLANNING_PENDING") {
              const userInputText = typeof userInput === "string" ? userInput : (userInput as any[]).map((p: any) => p.type === "text" ? p.text : "").join(" ");
              const lowerInput = userInputText.toLowerCase().trim();
              const confirmationWords = [
                "oke", "ok", "okay", "yes", "y", "sip", "siap", "lanjut", "lanjutkan", 
                "proceed", "go", "approved", "approve", "lgtm", "agree", "yep", "yup", 
                "sure", "mantap", "gas", "confirm", "konfirmasi", "confirmsi", "acc", 
                "setuju", "deal", "perbaik", "perbaiki"
              ];
              const words = lowerInput.split(/[^a-zA-Z0-9'']+/).filter(Boolean);
              const isConfirmation = confirmationWords.some(w => words.includes(w) || lowerInput.includes(w));
              if (isConfirmation) {
                agent.planState = agent.hasRealPlanContent() ? "APPROVED" : "IDLE";
                agent.simpleTaskApproved = true;
                // Reset current classification to complex_task (full toolset) so execution is not constrained by conversation category tools
                agent.currentClassification = {
                  category: "complex_task",
                  confidence: "high",
                  reason: "User confirmed pending plan; restored full execution toolset",
                  heuristicOnly: true,
                  classificationTokens: 0,
                };
                agent.writeToLogFile("INFO", `Plan state transitioned from PLANNING_PENDING to APPROVED via user confirmation: "${userInputText}"`);
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

                try {
                  const { logPrompt } = await import("./PromptLogger.js");
                  logPrompt("RequestProcessor:classifyRequest", model?.modelId, undefined, classificationPrompt, agent);
                } catch {}

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
          // Silently fall back to heuristic when LLM/local-model classification fails.
          // No user-facing warning — heuristic result is good enough to continue.
          agent.writeToLogFile("WARN", `Classifier failed, using heuristic fallback (category=${heuristicResult.category}, confidence=${heuristicResult.confidence}): ${err.message}`);
          agent.currentClassification = { ...heuristicResult, heuristicOnly: true };
          if (agent.planState === "IDLE") {
            const skipPlanningCategories = ["conversation", "question", "research"];
            if (skipPlanningCategories.includes(heuristicResult.category)) {
              agent.isSimpleTask = true;
              agent.planState = "APPROVED";
              agent.simpleTaskApproved = true;
            } else if (heuristicResult.category === "simple_edit" || heuristicResult.category === "command" || heuristicResult.category === "debug") {
              agent.isSimpleTask = true;
              agent.planState = "APPROVED";
              agent.simpleTaskApproved = true;
            }
            // complex_task with low heuristic confidence → leave planState IDLE, main loop handles planning
          }
        }
      }
    }

    if (agent.currentClassification) {
      try {
        const messages = agent.conversation.getMessages();
        const hasToolCalls = messages.some(m => m.role === "tool" || (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0));
        const { isHighConfidenceConversation } = await import("../requestClassifier.js");
        if (!hasToolCalls && isHighConfidenceConversation(agent.currentClassification, agent.tier, agent.planState)) {
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
      if (typeof (agent as any).hasRealPlanContent === "function" && !(agent as any).hasRealPlanContent()) {
        agent.planState = "IDLE";
      } else {
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
            agent.planState = "IDLE";
          }
        } catch (err: any) {
          agent.writeToLogFile("WARN", `Failed to auto-archive completed tasks: ${err.message}`);
        }
      }
    }

    return true;
  }
}
