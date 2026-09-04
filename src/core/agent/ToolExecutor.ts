import fs from "fs";
import path from "path";
import {
  executeToolCall,
  getToolDescription,
  isDangerousCommand,
  MODIFYING_TOOLS,
  isToolCallOutOfBounds,
  isModelConfigAccess,
  isSensitiveEnvFileAccess,
} from "../permissions.js";
import type { ToolCall, ToolResult } from "../conversation.js";
import type { QuestionItem } from "./AgentEvents.js";
import type { Agent } from "../agent.js";

export class ToolExecutor {
  public static async executeTools(
    agent: Agent,
    toolCalls: ToolCall[],
    toolDefs: any[],
    filteredToolDefs: any[],
    supportsNativeTools: boolean,
    systemPrompt: string,
    signal?: AbortSignal
  ): Promise<ToolResult[]> {
    const toolResults: ToolResult[] = [];

    // Pre-resolve active tools once for the batch (avoids per-tool dynamic imports)
    let cachedActiveTools: any[] | undefined;
    try {
      cachedActiveTools = await agent.getActiveTools();
    } catch {}

    // Deduplicate autoCheckpoint: run once per batch if any tool is modifying
    const hasModifyingTool = toolCalls.some(tc => MODIFYING_TOOLS.includes(tc.name));
    if (hasModifyingTool) {
      (agent as any).autoCheckpoint("Pre-edit");
    }

    for (const tc of toolCalls) {
      if (signal?.aborted) {
        const err = new Error("AbortError");
        err.name = "AbortError";
        throw err;
      }
      const description = getToolDescription(tc);
      agent.onEvent({ type: "tool_start", toolCall: tc, description });

      if (tc.name === "ask_question") {
        if (Array.isArray(tc.args.questions) && tc.args.questions.length > 0) {
          const normalizedQuestions: QuestionItem[] = tc.args.questions.map((q: any) => {
            const qObj = q as Record<string, any>;
            const qOpts = Array.isArray(qObj.options) ? qObj.options.map((o: any) => {
              if (typeof o === "string") return o;
              if (o && typeof o === "object") {
                const label = o["label"] ?? o["name"] ?? o["command"] ?? o["title"] ?? o["value"];
                if (label !== undefined) return String(label);
                return JSON.stringify(o);
              }
              return String(o);
            }) : [];
            return {
              question: String(qObj.question || ""),
              options: qOpts,
              isMultiSelect: !!(qObj.is_multi_select ?? qObj.isMultiSelect),
              inputType: qObj.inputType as "select" | "text" | "password" | undefined,
            };
          });

          if (normalizedQuestions.length === 1) {
            try {
              const q = normalizedQuestions[0];
              const selected = await (agent as any).onQuestion(q.question, q.options, q.isMultiSelect, undefined, q.inputType);
              const toolResult: ToolResult = {
                toolCallId: tc.id,
                name: tc.name,
                result: `User selected option: "${selected}"`,
              };
              toolResults.push(toolResult);
              agent.onEvent({ type: "tool_end", toolResult, description });
              continue;
            } catch (err: any) {
              const toolResult: ToolResult = {
                toolCallId: tc.id,
                name: tc.name,
                result: `Error getting user answer: ${err.message}`,
                isError: true,
              };
              toolResults.push(toolResult);
              agent.onEvent({ type: "tool_end", toolResult, description });
              continue;
            }
          }

          try {
            const selected = await (agent as any).onQuestion(normalizedQuestions);
            const toolResult: ToolResult = {
              toolCallId: tc.id,
              name: tc.name,
              result: `User selected options: ${JSON.stringify(selected)}`,
            };
            toolResults.push(toolResult);
            agent.onEvent({ type: "tool_end", toolResult, description });
            continue;
          } catch (err: any) {
            const toolResult: ToolResult = {
              toolCallId: tc.id,
              name: tc.name,
              result: `Error getting user answers: ${err.message}`,
              isError: true,
            };
            toolResults.push(toolResult);
            agent.onEvent({ type: "tool_end", toolResult, description });
            continue;
          }
        }

        let question = tc.args.question as string || "";
        let rawOptionsVal = tc.args.options;
        let isMultiSelect = tc.args.isMultiSelect as boolean | undefined;
        let inputType = tc.args.type as string | undefined;
        inputType = inputType === "text" || inputType === "password" ? inputType : undefined;

        const rawOptions = Array.isArray(rawOptionsVal)
          ? rawOptionsVal
          : (rawOptionsVal !== undefined && rawOptionsVal !== null ? [rawOptionsVal] : []);
        const options: string[] = rawOptions.map((o) => {
          if (typeof o === "string") return o;
          if (o && typeof o === "object") {
            const obj = o as Record<string, unknown>;
            const label = obj["label"] ?? obj["name"] ?? obj["command"] ?? obj["title"] ?? obj["value"];
            if (label !== undefined) return String(label);
            return JSON.stringify(o);
          }
          return String(o);
        });
        try {
          const selected = await (agent as any).onQuestion(question, options, isMultiSelect, undefined, inputType);
          const toolResult: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            result: `User selected option: "${selected}"`,
          };
          toolResults.push(toolResult);
          agent.onEvent({ type: "tool_end", toolResult, description });
          continue;
        } catch (err: any) {
          const toolResult: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            result: `Error getting user answer: ${err.message}`,
            isError: true,
          };
          toolResults.push(toolResult);
          agent.onEvent({ type: "tool_end", toolResult, description });
          continue;
        }
      }

      if (tc.name === "invoke_superagent" || tc.name === "merge_superagents") {
        if (agent.planState !== "APPROVED") {
          let msg = "";
          if (agent.planState === "PLANNING_PENDING") {
            msg = `Error: Spawning or merging Superagents is blocked. A plan is pending approval. You must wait for the user to approve the plan using the interactive approval wizard before starting execution.`;
          } else {
            msg = `Error: Spawning or merging Superagents is blocked. You must first write an implementation plan to '${agent.getPlanFilePath()}' and have the user approve it before you can invoke any Superagents.`;
          }
          const blocked: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            result: msg,
            isError: true,
          };
          toolResults.push(blocked);
          agent.onEvent({ type: "tool_end", toolResult: blocked, description });
          continue;
        }

        const taskFilePath = agent.getTaskFilePath();
        if (!fs.existsSync(taskFilePath)) {
          // ── Auto-create _task.md instead of blocking ─────────────────
          let taskContent = "# Tasks\n\n- [ ] Execute implementation plan\n";
          try {
            const planPath = agent.getPlanFilePath();
            if (fs.existsSync(planPath)) {
              const planContent = fs.readFileSync(planPath, "utf-8");
              const taskLines: string[] = [];
              for (const line of planContent.split(/\r?\n/)) {
                const match = line.match(/^\s*-\s*`?\[([xX/ ])\]`?\s*(.*)$/);
                if (match) {
                  taskLines.push(`- [${match[1]}] ${match[2].trim()}`);
                }
              }
              if (taskLines.length > 0) {
                taskContent = taskLines.join("\n") + "\n";
              }
            }
          } catch {
            // Fallback: use minimal placeholder
          }

          try {
            fs.mkdirSync(path.dirname(taskFilePath), { recursive: true });
            fs.writeFileSync(taskFilePath, taskContent, "utf-8");
            agent.writeToLogFile("INFO", `Auto-created missing task file at ${taskFilePath} — proceeding with spawn/merge.`);
          } catch (createErr: any) {
            agent.writeToLogFile("WARN", `Failed to auto-create task file: ${createErr.message} — proceeding anyway.`);
          }
        }
      }

      if (MODIFYING_TOOLS.includes(tc.name)) {
        const filePath = tc.args.filePath as string || tc.args.file_path as string || tc.args.TargetFile as string || "";
        const planFilePath = agent.getPlanFilePath();
        const taskFilePath = agent.getTaskFilePath();
        const walkthroughFilePath = agent.getWalkthroughFilePath();
        const isPlanFile = filePath && path.resolve(filePath).toLowerCase() === path.resolve(planFilePath).toLowerCase();
        const isTaskFile = filePath && path.resolve(filePath).toLowerCase() === path.resolve(taskFilePath).toLowerCase();
        const isWalkthroughFile = filePath && path.resolve(filePath).toLowerCase() === path.resolve(walkthroughFilePath).toLowerCase();

        if (agent.isSimpleTask && !agent.simpleTaskApproved && !isPlanFile && !isTaskFile && !isWalkthroughFile) {
          const filename = path.basename(filePath);
          try {
            const selected = await (agent as any).onQuestion(
              `Agent is about to modify ${filename}. Proceed with modifications?`,
              ["Yes", "No"]
            );
            if (selected === "Yes") {
              agent.simpleTaskApproved = true;
            } else {
              const blocked: ToolResult = {
                toolCallId: tc.id,
                name: tc.name,
                result: `Error: User rejected modification of ${filename}.`,
                isError: true,
              };
              toolResults.push(blocked);
              agent.onEvent({ type: "tool_end", toolResult: blocked, description });
              continue;
            }
          } catch (err: any) {
            const blocked: ToolResult = {
              toolCallId: tc.id,
              name: tc.name,
              result: `Error: Modification confirmation failed: ${err.message}`,
              isError: true,
            };
            toolResults.push(blocked);
            agent.onEvent({ type: "tool_end", toolResult: blocked, description });
            continue;
          }
        }

        if (agent.tier === "master" && !isPlanFile && !isTaskFile && !isWalkthroughFile) {
          if (agent.isSimpleTask) {
            // Bypass the Master Agent direct file modification block
          } else {
            const blocked: ToolResult = {
              toolCallId: tc.id,
              name: tc.name,
              result: "Error: The Master Agent is restricted from directly modifying source code files in the codebase. You must delegate all code modifications to Superagents by invoking them.",
              isError: true,
            };
            try {
              const { appendToolsErrorLog } = await import("../tools/state.js");
              appendToolsErrorLog(agent.tier, agent.delegationDepth, tc.name, blocked.result, { filePath, reason: "master_direct_modify_blocked" });
            } catch {}
            (agent as any).emitViolation("master_direct_modify_blocked", tc.name, "Master Agent attempted to directly modify source code files. Must delegate to Superagents.", "critical", { filePath });
            toolResults.push(blocked);
            agent.onEvent({ type: "tool_end", toolResult: blocked, description });
            continue;
          }
        }

        if (isPlanFile) {
          let planContent = "";
          if (tc.name === "write" || tc.name === "write_to_file") {
            planContent = (tc.args.content as string || tc.args.codeContent as string || tc.args.CodeContent as string || "").trim();
          } else if (tc.name === "replace_file_content") {
            const target = tc.args.TargetContent as string || "";
            const replacement = tc.args.ReplacementContent as string || "";
            const existing = fs.existsSync(planFilePath) ? fs.readFileSync(planFilePath, "utf8") : "";
            planContent = existing.replace(target, replacement);
          } else if (tc.name === "multi_replace_file_content") {
            let existing = fs.existsSync(planFilePath) ? fs.readFileSync(planFilePath, "utf8") : "";
            let chunks: any[] = [];
            if (Array.isArray(tc.args.files)) {
              for (const file of tc.args.files) {
                const fc = file?.chunks || file?.ReplacementChunks || file?.replacementChunks || file?.replacements || [];
                if (Array.isArray(fc)) chunks.push(...fc);
              }
            } else {
              const chunksVal = tc.args.ReplacementChunks ?? tc.args.chunks ?? tc.args.replacementChunks ?? tc.args.replacements;
              chunks = Array.isArray(chunksVal)
                ? chunksVal
                : (chunksVal !== undefined && chunksVal !== null ? [chunksVal] : []);
            }
            for (const chunk of chunks) {
              const target = (chunk.TargetContent ?? chunk.targetContent ?? chunk.oldContent) as string || "";
              const replacement = (chunk.ReplacementContent ?? chunk.replacementContent ?? chunk.newContent) as string || "";
              if (target) existing = existing.replace(target, replacement);
            }
            planContent = existing;
          } else {
            planContent = (tc.args.content as string || tc.args.codeContent as string || tc.args.CodeContent as string || "").trim();
          }

          if (agent.tier === "master") {
            const hasSuperagentOrDelegate = /superagent|spawning|delegate|worktree/i.test(planContent);
            if (!hasSuperagentOrDelegate) {
              planContent = planContent + "\n\n> **Note**: This plan will be executed by spawning Superagents in isolated git worktrees for parallel feature development.";
              if (tc.args.planContent !== undefined) {
                tc.args.planContent = planContent;
              } else if (tc.args.content !== undefined) {
                tc.args.content = planContent;
              }
              console.log("[INFO] Auto-injected delegation context into implementation plan");
            }
          }

          if (agent.goalMode) {
            agent.planState = "APPROVED";
            agent.onEvent({ type: "text", content: "\n[SYS] Goal Mode active: Auto-approving implementation plan for autonomous execution.\n" });
          } else if (agent.planState !== "APPROVED") {
            agent.planState = "PLANNING_PENDING";
          }
        }

        if (isTaskFile) {
          let taskContent = "";
          if (tc.name === "write" || tc.name === "write_to_file") {
            taskContent = (tc.args.content as string || tc.args.codeContent as string || tc.args.CodeContent as string || "").trim();
          } else if (tc.name === "replace_file_content") {
            const target = tc.args.TargetContent as string || "";
            const replacement = tc.args.ReplacementContent as string || "";
            const existing = fs.existsSync(taskFilePath) ? fs.readFileSync(taskFilePath, "utf8") : "";
            taskContent = existing.replace(target, replacement);
          } else if (tc.name === "multi_replace_file_content") {
            let existing = fs.existsSync(taskFilePath) ? fs.readFileSync(taskFilePath, "utf8") : "";
            let chunks: any[] = [];
            if (Array.isArray(tc.args.files)) {
              for (const file of tc.args.files) {
                const fc = file?.chunks || file?.ReplacementChunks || file?.replacementChunks || file?.replacements || [];
                if (Array.isArray(fc)) chunks.push(...fc);
              }
            } else {
              const chunksVal = tc.args.ReplacementChunks ?? tc.args.chunks ?? tc.args.replacementChunks ?? tc.args.replacements;
              chunks = Array.isArray(chunksVal)
                ? chunksVal
                : (chunksVal !== undefined && chunksVal !== null ? [chunksVal] : []);
            }
            for (const chunk of chunks) {
              const target = (chunk.TargetContent ?? chunk.targetContent ?? chunk.oldContent) as string || "";
              const replacement = (chunk.ReplacementContent ?? chunk.replacementContent ?? chunk.newContent) as string || "";
              if (target) existing = existing.replace(target, replacement);
            }
            taskContent = existing;
          } else {
            taskContent = (tc.args.content as string || tc.args.codeContent as string || tc.args.CodeContent as string || "").trim();
          }

          if (agent.tier === "master") {
            const lines = taskContent.split(/\r?\n/);
            const taskLines: string[] = [];
            const otherLines: string[] = [];

            for (const line of lines) {
              if (/^\s*-\s*`?\[([xX/ ])\]`?\s*/.test(line)) {
                taskLines.push(line);
              } else {
                otherLines.push(line);
              }
            }

            const combinedTaskText = taskLines.join("\n").toLowerCase();
            const hasSpawn = /spawn|invoke|create.*superagent|start.*superagent/i.test(combinedTaskText);
            const hasMonitor = /monitor|await|wait|track|check.*status/i.test(combinedTaskText);
            const hasMerge = /merge|combine|integrate.*superagent/i.test(combinedTaskText);
            const hasConclusion = /conclusion|summary|walkthrough|final report|verify.*merged/i.test(combinedTaskText);

            const injectedTasks: string[] = [];
            if (!hasSpawn) {
              injectedTasks.push("- [ ] Spawn Superagents for parallel task execution");
            }
            if (!hasMonitor) {
              injectedTasks.push("- [ ] Monitor Superagent progress and await completion");
            }
            if (!hasMerge) {
              injectedTasks.push("- [ ] Merge Superagent branches into main codebase");
            }
            if (!hasConclusion) {
              injectedTasks.push("- [ ] Validate merged changes and provide project completion conclusion");
            }

            if (injectedTasks.length > 0) {
              const lastTaskIndex = lines.length - 1 - [...lines].reverse().findIndex(l => /^\s*-\s*`?\[([xX/ ])\]`?\s*/.test(l));
              lines.splice(lastTaskIndex + 1, 0, ...injectedTasks);
              taskContent = lines.join("\n");
              if (tc.args.content !== undefined) {
                tc.args.content = taskContent;
              } else if (tc.args.codeContent !== undefined) {
                tc.args.codeContent = taskContent;
              } else if (tc.args.CodeContent !== undefined) {
                tc.args.CodeContent = taskContent;
              }
              console.log(`[INFO] Auto-injected ${injectedTasks.length} missing Master Agent task(s) into task file`);
            }
          }
        }

        if (!isPlanFile && agent.planState === "PLANNING_PENDING") {
          const blocked: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            result: "Error: File modification blocked. A plan is pending approval. You must wait for the user to approve the plan using the interactive approval wizard before modifying any codebase files.",
            isError: true,
          };
          try {
            const { appendToolsErrorLog } = await import("../tools/state.js");
            appendToolsErrorLog(agent.tier, agent.delegationDepth, tc.name, blocked.result, { filePath, reason: "planning_pending" });
          } catch {}
          (agent as any).emitViolation("planning_pending", tc.name, "File modification blocked while plan is pending approval.", "warning", { filePath });
          toolResults.push(blocked);
          agent.onEvent({ type: "tool_end", toolResult: blocked, description });
          continue;
        }
      }

      if (
        tc.name === "bash" || tc.name === "run_command" || tc.name === "run_background_process"
      ) {
        if (agent.planState === "PLANNING_PENDING") {
          const cmd = (tc.args.command as string || "").trim();
          const isModifyingCommand = /([>\u226B\u00BB]|\b(rm|rmdir|mkdir|cp|mv|touch|git\s+(checkout|apply|reset|clean|merge|rebase|commit|add|push|pull)|npm\s+(install|i|uninstall|update|add)|yarn\s+(add|remove|upgrade|install)|pnpm\s+(add|remove|update|install|i))\b)/i.test(cmd);
          if (isModifyingCommand) {
            const blocked: ToolResult = {
              toolCallId: tc.id,
              name: tc.name,
              result: `Error: Terminal command blocked. A plan is pending approval. You must wait for the user to approve the plan using the interactive approval wizard before running commands that modify the codebase or repository state. Command blocked: "${cmd}"`,
              isError: true,
            };
            try {
              const { appendToolsErrorLog } = await import("../tools/state.js");
              appendToolsErrorLog(agent.tier, agent.delegationDepth, tc.name, blocked.result, { command: cmd, reason: "planning_pending_command" });
            } catch {}
            (agent as any).emitViolation("planning_pending_command", tc.name, `Modifying terminal command blocked while plan is pending approval: "${cmd}"`, "warning", { command: cmd });
            toolResults.push(blocked);
            agent.onEvent({ type: "tool_end", toolResult: blocked, description });
            continue;
          }
        }

        if (isDangerousCommand(tc.args.command as string) && !agent.allowSessionDangerous) {
          const approved = await (agent as any).onPermission(tc, description);
          if (approved === "session") {
            agent.allowSessionDangerous = true;
          } else if (!approved) {
            const denied: ToolResult = {
              toolCallId: tc.id,
              name: tc.name,
              result: "User denied permission for this command.",
              isError: true,
            };
            try {
              const { appendToolsErrorLog } = await import("../tools/state.js");
              appendToolsErrorLog(agent.tier, agent.delegationDepth, tc.name, denied.result, { command: tc.args.command as string, reason: "user_permission_denied" });
            } catch {}
            (agent as any).emitViolation("user_permission_denied", tc.name, `Dangerous command denied by user/permission handler: "${tc.args.command as string}"`, "critical", { command: tc.args.command as string });
            toolResults.push(denied);
            agent.onEvent({ type: "tool_end", toolResult: denied, description });
            continue;
          }
        }
      }

      const effectiveWorkspace = agent.worktreePath || agent.workingDirectory;
      const isModelCfg = isModelConfigAccess(tc, effectiveWorkspace);
      const isEnvFile = !isModelCfg && isSensitiveEnvFileAccess(tc);
      const isFileWriteTool = MODIFYING_TOOLS.includes(tc.name);
      const needsPermission = isModelCfg
        ? true
        : isEnvFile
        ? !agent.allowSessionEnvAccess
        : isToolCallOutOfBounds(tc, effectiveWorkspace) &&
          (isFileWriteTool ? !agent.allowSessionFileWriteOutOfBounds : !agent.allowSessionOutOfBounds);
      if (needsPermission) {
        let details = "";
        if (tc.args) {
          const cmd = (tc.args.command ?? tc.args.cmd) as string | undefined;
          const targetPath = (tc.args.filePath ?? tc.args.file_path ?? tc.args.TargetFile ?? tc.args.path ?? tc.args.DirectoryPath ?? tc.args.SearchPath ?? tc.args.AbsolutePath) as string | undefined;
          const cwd = tc.args.cwd as string | undefined;
          const detailsParts: string[] = [];
          if (cmd) detailsParts.push(`Command: "${cmd}"`);
          if (targetPath) detailsParts.push(`Target Path: "${targetPath}"`);
          if (cwd) detailsParts.push(`CWD: "${cwd}"`);
          if (detailsParts.length > 0) {
            details = `\n  Details:\n    - ${detailsParts.join("\n    - ")}`;
          }
        }

        const permMessage = isModelCfg
          ? `⚠️  Protected file access detected: model-config.json contains your API keys and model presets. Tool "${tc.name}" is attempting to access this file. This requires your explicit permission.`
          : isEnvFile
          ? `⚠️  Sensitive file access detected: Tool "${tc.name}" is attempting to access a .env file which may contain API keys, database credentials, or other secrets. This requires your explicit permission.`
          : isFileWriteTool
          ? `⚠️  Out-of-bounds FILE WRITE detected: Tool "${tc.name}" is attempting to write a file OUTSIDE the workspace directory.${details}\n\n  ⚠️  WARNING: "Allow for This Session" for file writes grants permanent bypass for all future out-of-bounds writes this session.`
          : `Out-of-bounds access detected for tool: ${tc.name}. Requires permission to access files/directories/processes outside the workspace.${details}`;
        const approved = await (agent as any).onPermission(
          tc,
          permMessage
        );
        if (!isModelCfg && !isEnvFile && isFileWriteTool && approved === "session") {
          agent.allowSessionFileWriteOutOfBounds = true;
        } else if (!isModelCfg && !isEnvFile && !isFileWriteTool && approved === "session") {
          agent.allowSessionOutOfBounds = true;
        } else if (!isModelCfg && isEnvFile && approved === "session") {
          agent.allowSessionEnvAccess = true;
        } else if (!approved) {
          const blocked: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            result: `Error: Access denied. Permission denied to access files/directories/processes outside the workspace directory: ${effectiveWorkspace}`,
            isError: true,
          };
          try {
            const { appendToolsErrorLog } = await import("../tools/state.js");
            appendToolsErrorLog(agent.tier, agent.delegationDepth, tc.name, blocked.result, { workspace: effectiveWorkspace, reason: "out_of_bounds_denied" });
          } catch {}
          (agent as any).emitViolation("out_of_bounds_denied", tc.name, `Access outside workspace denied by user/permission handler.`, "critical", { workspace: effectiveWorkspace });
          toolResults.push(blocked);
          agent.onEvent({ type: "tool_end", toolResult: blocked, description });
          continue;
        }
      }

      const effectiveCwd = (agent.tier === "superagent" && agent.worktreePath)
        ? agent.worktreePath
        : agent.workingDirectory;

      const toolResult = await executeToolCall(
        tc,
        effectiveCwd,
        signal,
        cachedActiveTools
      );
      if (signal?.aborted) {
        const err = new Error("AbortError");
        err.name = "AbortError";
        throw err;
      }
      toolResults.push(toolResult);
      agent.onEvent({ type: "tool_end", toolResult, description, toolCall: tc });
    }

    return toolResults;
  }
}
