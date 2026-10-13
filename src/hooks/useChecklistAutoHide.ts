import { useState, useEffect, useRef } from "react";
import { superagentInstances } from "../core/tools.js";

export interface ChecklistTaskItem {
  status: string;
  text: string;
}

export interface UseChecklistAutoHideOptions {
  checklistTasks: ChecklistTaskItem[];
  planState: string;
  isMultiAgent?: boolean;
  instances?: Map<string, any> | Iterable<any>;
  delaySeconds?: number;
  onAutoHidden?: () => void;
}

export interface UseChecklistAutoHideResult {
  isAutoHidden: boolean;
  remainingSeconds: number | undefined;
  areAllCompleted: boolean;
  resetAutoHide: () => void;
}

/**
 * Check if all tasks in the list are completed.
 * Takes into account multi-agent dynamic status resolution if applicable.
 */
export function areAllTasksCompleted(
  tasks: ChecklistTaskItem[],
  isMultiAgent?: boolean,
  instances?: Map<string, any> | Iterable<any>
): boolean {
  if (!tasks || tasks.length === 0) return false;

  const instMap = instances || (isMultiAgent ? superagentInstances : undefined);
  const instValues = instMap
    ? instMap instanceof Map
      ? Array.from(instMap.values())
      : Array.from(instMap)
    : [];

  for (const task of tasks) {
    let status = task.status;
    if (isMultiAgent && instValues.length > 0) {
      for (const inst of instValues) {
        const roleLower = (inst.role || "").toLowerCase();
        if (task.text.toLowerCase().includes(roleLower)) {
          const isMergeOrCleanup = /merge|cleanup|prune/i.test(task.text);
          if (!isMergeOrCleanup) {
            if (inst.status === "running") status = "/";
            else if (inst.status === "paused") status = "paused";
            else if (inst.status === "completed") status = "x";
            else if (inst.status === "error") status = "error";
          } else {
            if (inst.status === "completed") status = "/";
          }
          break;
        }
      }
    }
    if (status !== "x") {
      return false;
    }
  }

  return true;
}

/**
 * Hook to manage auto-hiding of active task checklist after all tasks are completed.
 * Provides a 5-second (configurable) countdown before automatically hiding.
 */
export function useChecklistAutoHide({
  checklistTasks,
  planState,
  isMultiAgent = false,
  instances,
  delaySeconds = 5,
  onAutoHidden,
}: UseChecklistAutoHideOptions): UseChecklistAutoHideResult {
  const [isAutoHidden, setIsAutoHidden] = useState<boolean>(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number | undefined>(undefined);

  const completedAtRef = useRef<number | null>(null);
  const tasksSignatureRef = useRef<string>("");

  const areAllCompleted =
    planState !== "PLANNING_PENDING" &&
    areAllTasksCompleted(checklistTasks, isMultiAgent, instances);

  const taskSignature = checklistTasks.map((t) => `${t.status}:${t.text}`).join("|");

  useEffect(() => {
    if (!areAllCompleted) {
      completedAtRef.current = null;
      tasksSignatureRef.current = taskSignature;
      setIsAutoHidden(false);
      setRemainingSeconds(undefined);
      return;
    }

    // If newly completed or tasks changed
    if (completedAtRef.current === null || tasksSignatureRef.current !== taskSignature) {
      completedAtRef.current = Date.now();
      tasksSignatureRef.current = taskSignature;
      setIsAutoHidden(false);
      setRemainingSeconds(delaySeconds);
    }

    const updateCountdown = () => {
      if (!completedAtRef.current) return;
      const elapsed = Date.now() - completedAtRef.current;
      const remaining = Math.max(0, Math.ceil((delaySeconds * 1000 - elapsed) / 1000));
      if (remaining <= 0) {
        setIsAutoHidden(true);
        setRemainingSeconds(undefined);
        onAutoHidden?.();
      } else {
        setRemainingSeconds(remaining);
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);

    return () => clearInterval(interval);
  }, [areAllCompleted, taskSignature, delaySeconds, onAutoHidden]);

  const resetAutoHide = () => {
    completedAtRef.current = null;
    setIsAutoHidden(false);
    setRemainingSeconds(undefined);
  };

  return {
    isAutoHidden,
    remainingSeconds,
    areAllCompleted,
    resetAutoHide,
  };
}
