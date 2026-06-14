import { useCallback } from "react";
import type { Agent } from "../../core/agent.js";
import type { ChatLine } from "../../core/slash-commands.js";

interface GoalWizardContext {
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
  setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  addLine: (line: ChatLine) => void;
  setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  setGoalMode: React.Dispatch<React.SetStateAction<any>>;
  agentRef: React.MutableRefObject<Agent | null>;
}

export function useGoalWizard(ctx: GoalWizardContext) {
  const {
    setActiveWizard,
    setWizardOptions,
    setWizardSelectedIndex,
    addLine,
    setIsProcessing,
    setGoalMode,
    agentRef,
  } = ctx;

  const handleGoalWizard = useCallback((value: string, step: number, data: Record<string, string>) => {
    const now = Date.now();

    setActiveWizard(null);
    setWizardOptions([]);
    setWizardSelectedIndex(0);
    if (!value.trim()) return;
    const goalArg = value.trim();
    if (agentRef.current) {
      agentRef.current.goalMode = goalArg;
    }
    setGoalMode({ goal: goalArg, startedAt: now });
    addLine({
      type: "system",
      content: [
        "🎯 GOAL MODE ACTIVATED",
        `   Objective : ${goalArg}`,
        "   Iterations: up to 200 steps (auto-continue enabled)",
        "   The agent will not stop until the goal is achieved.",
        "   Use Ctrl+C to abort at any time.",
      ].join("\n"),
      timestamp: now,
    });
    addLine({
      type: "user",
      content: `❯ /goal ${goalArg}`,
      timestamp: now,
    });
    setIsProcessing(true);
    agentRef.current?.sendMessage(
      `GOAL MODE: Your primary objective is to achieve the following goal completely and verifiably:\n\n"${goalArg}"\n\nBegin immediately. Plan thoroughly, execute step by step, verify completion, and report back with GOAL_COMPLETE or GOAL_PARTIAL.`
    ).catch((err: any) => {
      addLine({ type: "error", content: `Goal mode error: ${err.message}`, timestamp: Date.now() });
    });
  }, [
    setActiveWizard,
    setWizardOptions,
    setWizardSelectedIndex,
    addLine,
    setIsProcessing,
    setGoalMode,
    agentRef
  ]);

  return handleGoalWizard;
}
