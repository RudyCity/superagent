import { useCallback } from "react";
import fs from "fs";
import type { ChatLine } from "../core/slash-commands.js";
import type { ToolCall } from "../core/conversation.js";
import { checkPlanStructure, type Agent, type QuestionItem } from "../core/agent.js";
import type { Checkpoint } from "../core/checkpoints.js";

// Import sub-wizards
import { useLoginWizard } from "./wizard/useLoginWizard.js";
import { useModelWizard } from "./wizard/useModelWizard.js";
import { useGoalWizard } from "./wizard/useGoalWizard.js";

export interface WizardSubmitContext {
  activeWizard: {
    type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills" | "exit_confirm";
    step: number;
    data: Record<string, string>;
    isMultiSelect?: boolean;
    questions?: QuestionItem[];
    currentQuestionIndex?: number;
    answers?: string[];
  } | null;
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  wizardOptions: string[];
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
  wizardSelectedIndex: number;
  setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  setWizardSelectedSet: React.Dispatch<React.SetStateAction<Set<number>>>;
  setCheckpointsList: React.Dispatch<React.SetStateAction<Checkpoint[]>>;
  addLine: (line: ChatLine) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  isProcessing: boolean;
  setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  setContextLimit: React.Dispatch<React.SetStateAction<number>>;
  setActiveModel: React.Dispatch<React.SetStateAction<string>>;
  setPlanState: React.Dispatch<React.SetStateAction<any>>;
  setGoalMode: React.Dispatch<React.SetStateAction<any>>;
  agentRef: React.MutableRefObject<Agent | null>;
  pendingPermission: {
    toolCall: ToolCall;
    description: string;
    resolve: (value: boolean) => void;
  } | null;
  setPendingPermission: React.Dispatch<React.SetStateAction<any>>;
  pendingQuestion: {
    question: string;
    options: string[];
    resolve: (value: any) => void;
  } | null;
  setPendingQuestion: React.Dispatch<React.SetStateAction<any>>;
  wizardIsLoadingModels: boolean;
  setWizardIsLoadingModels: React.Dispatch<React.SetStateAction<boolean>>;
  planState: string;
  streamBufferRef: React.MutableRefObject<string>;
  setStreamDisplay: React.Dispatch<React.SetStateAction<string>>;
  exit?: () => void;
}

export function useWizardSubmit(ctx: WizardSubmitContext) {
  const {
    activeWizard,
    setActiveWizard,
    wizardOptions,
    setWizardOptions,
    wizardSelectedIndex,
    setWizardSelectedIndex,
    setWizardSelectedSet,
    addLine,
    setInput,
    setIsProcessing,
    setPlanState,
    agentRef,
    pendingQuestion,
    setPendingQuestion,
    planState,
    streamBufferRef,
    setStreamDisplay,
    exit,
  } = ctx;

  const handleLoginWizard = useLoginWizard(ctx);
  const handleModelWizard = useModelWizard(ctx);
  const handleGoalWizard = useGoalWizard(ctx);

  const handleWizardSubmit = useCallback((value: string) => {
    if (!activeWizard) return;
    const now = Date.now();

    if (activeWizard.type === "exit_confirm") {
      if (value === "Yes, exit") {
        exit?.();
      } else {
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        addLine({
          type: "system",
          content: "Exit cancelled. Retaining session.",
          timestamp: now,
        });
      }
      return;
    }

    if (activeWizard.type === "login") {
      handleLoginWizard(value, activeWizard.step, activeWizard.data);
      return;
    }

    if (activeWizard.type === "model") {
      handleModelWizard(value, activeWizard.step, activeWizard.data);
      return;
    }

    if (activeWizard.type === "goal") {
      handleGoalWizard(value, activeWizard.step, activeWizard.data);
      return;
    }

    if (activeWizard.type === "plan_approve") {
      // Step 2: custom feedback — send feedback to agent for revision
      if (activeWizard.step === 2) {
        const feedback = (typeof value === "string" ? value : "").trim();
        if (!feedback) return;
        if (agentRef.current) {
          agentRef.current.planState = "IDLE";
          setPlanState("IDLE");
          setIsProcessing(true);
          streamBufferRef.current = "";
          setStreamDisplay("");
          agentRef.current.sendMessage(`Plan revision feedback: ${feedback}`).catch((err: any) => {
            setIsProcessing(false);
            addLine({ type: "error", content: `Plan feedback error: ${err.message}`, timestamp: Date.now() });
          });
        }
        addLine({
          type: "system",
          content: `💬 Plan feedback sent: "${feedback.slice(0, 100)}${feedback.length > 100 ? "..." : ""}"`,
          timestamp: now,
        });
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        return;
      }

      // Step 1: approve / reject
      const approved = value === "approve";
      if (approved && planState === "APPROVED") return;
      if (approved) {
        let isPlanValid = true;
        if (agentRef.current) {
          const planFilePath = agentRef.current.getPlanFilePath();
          try {
            if (fs.existsSync(planFilePath)) {
              const content = fs.readFileSync(planFilePath, "utf8");
              isPlanValid = checkPlanStructure(content);
            } else {
              isPlanValid = false;
            }
          } catch {
            isPlanValid = false;
          }
        }

        if (!isPlanValid) {
          addLine({
            type: "error",
            content: "⚠️ The implementation plan is invalid or lacks structure. A plan must match one of the template structures (full, quick, or refactor). Redirecting to request revision...",
            timestamp: now,
          });
          setActiveWizard({
            type: "plan_approve",
            step: 2,
            data: activeWizard.data,
          });
          return;
        }

        if (agentRef.current) {
          agentRef.current.approvePlan();
          setPlanState("APPROVED");
          setIsProcessing(true);
          streamBufferRef.current = "";
          setStreamDisplay("");
          agentRef.current.sendMessage("Implementation plan approved via interactive approval wizard. Continue with the approved plan now.").catch((err: any) => {
            setIsProcessing(false);
            addLine({ type: "error", content: `Plan approval resume error: ${err.message}`, timestamp: Date.now() });
          });
        }
        addLine({
          type: "system",
          content: "✅ Implementation plan approved! Continuing with the approved plan now.",
          timestamp: now,
        });
      } else {
        // Reject — stop the agent process
        if (agentRef.current) {
          agentRef.current.planState = "IDLE";
          setPlanState("IDLE");
          agentRef.current.abort();
        }
        setIsProcessing(false);
        addLine({
          type: "system",
          content: "❌ Implementation plan rejected. Agent process stopped.",
          timestamp: now,
        });
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      return;
    }

    if (activeWizard.type === "question") {
      const qList = activeWizard.questions;
      const currIdx = activeWizard.currentQuestionIndex;
      if (qList && currIdx !== undefined) {
        const updatedAnswers = [...(activeWizard.answers || [])];
        updatedAnswers[currIdx] = value;
        
        addLine({
          type: "system",
          content: `❓ Answered: "${value}"`,
          timestamp: now,
        });
        
        const nextIdx = currIdx + 1;
        if (nextIdx < qList.length) {
          const nextQ = qList[nextIdx];
          const hasOptions = Array.isArray(nextQ.options) && nextQ.options.length > 0;
          const allOptions = hasOptions ? [...nextQ.options, "Custom..."] : [];
          if (pendingQuestion) {
            setPendingQuestion({
              question: nextQ.question,
              options: allOptions,
              resolve: pendingQuestion.resolve,
            });
          }
          setWizardOptions(allOptions);
          
          const nextSavedAns = updatedAnswers[nextIdx] || "";
          if (nextQ.isMultiSelect) {
            const nextAnsList = nextSavedAns.split(", ").map(x => x.trim());
            const newSet = new Set<number>();
            allOptions.forEach((opt, idx) => {
              if (nextAnsList.includes(opt)) {
                newSet.add(idx);
              }
            });
            setWizardSelectedSet(newSet);
            setWizardSelectedIndex(0);
          } else {
            const optionIdx = nextQ.options.indexOf(nextSavedAns);
            if (optionIdx >= 0) {
              setWizardSelectedIndex(optionIdx);
            } else {
              setWizardSelectedIndex(0);
            }
            setWizardSelectedSet(new Set());
          }
          
          setInput("");
          
          const optionIdx = nextQ.options.indexOf(nextSavedAns);
          const isCustomAnswer = nextSavedAns !== "" && optionIdx < 0;
          
          if (isCustomAnswer && !nextQ.isMultiSelect) {
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setInput(nextSavedAns);
            setActiveWizard({
              ...activeWizard,
              step: 2,
              currentQuestionIndex: nextIdx,
              answers: updatedAnswers,
              isMultiSelect: nextQ.isMultiSelect,
            });
          } else {
            setActiveWizard({
              ...activeWizard,
              step: hasOptions ? 1 : 2,
              currentQuestionIndex: nextIdx,
              answers: updatedAnswers,
              isMultiSelect: nextQ.isMultiSelect,
            });
          }
        } else {
          if (pendingQuestion) {
            pendingQuestion.resolve(updatedAnswers);
            setPendingQuestion(null);
          }
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setWizardSelectedSet(new Set());
        }
        return;
      }

      if (pendingQuestion) {
        pendingQuestion.resolve(value);
        addLine({
          type: "system",
          content: `❓ Answered: "${value}"`,
          timestamp: now,
        });
        setPendingQuestion(null);
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      return;
    }
  }, [
    activeWizard,
    handleLoginWizard,
    handleModelWizard,
    handleGoalWizard,
    planState,
    agentRef,
    setPlanState,
    setIsProcessing,
    streamBufferRef,
    setStreamDisplay,
    addLine,
    setActiveWizard,
    setWizardOptions,
    setWizardSelectedIndex,
    setWizardSelectedSet,
    setInput,
    pendingQuestion,
    setPendingQuestion,
    exit,
  ]);

  return handleWizardSubmit;
}
