import { 
  BackgroundTask, 
  TaskChangeListener, 
  ActiveOutputListener, 
  ScheduleJob, 
  SubagentType, 
  SubagentInstance, 
  QuestionHandler 
} from "./types.js";

export const backgroundTasks = new Map<string, BackgroundTask>();
export const taskChangeListeners = new Set<TaskChangeListener>();
export const activeOutputListeners = new Set<ActiveOutputListener>();
export let activeToolOutput = "";

export function subscribeToTasks(listener: TaskChangeListener) {
  taskChangeListeners.add(listener);
  return () => {
    taskChangeListeners.delete(listener);
  };
}

export function notifyTasksChanged() {
  for (const listener of taskChangeListeners) {
    listener();
  }
}

export function subscribeToActiveOutput(listener: ActiveOutputListener) {
  activeOutputListeners.add(listener);
  return () => {
    activeOutputListeners.delete(listener);
  };
}

export function getActiveToolOutput() {
  return activeToolOutput;
}

export function clearActiveToolOutput() {
  activeToolOutput = "";
  for (const listener of activeOutputListeners) {
    listener("");
  }
}

export function appendActiveToolOutput(text: string) {
  activeToolOutput += text;
  const lines = activeToolOutput.split("\n");
  if (lines.length > 50) {
    activeToolOutput = lines.slice(lines.length - 50).join("\n");
  }
  for (const listener of activeOutputListeners) {
    listener(activeToolOutput);
  }
}

export const scheduledJobs = new Map<string, ScheduleJob>();
export type ScheduleChangeListener = (jobId: string, prompt: string) => void;
export const scheduleChangeListeners = new Set<ScheduleChangeListener>();

export function subscribeToSchedules(listener: ScheduleChangeListener) {
  scheduleChangeListeners.add(listener);
  return () => {
    scheduleChangeListeners.delete(listener);
  };
}

export function notifyScheduleTriggered(jobId: string, prompt: string) {
  for (const listener of scheduleChangeListeners) {
    listener(jobId, prompt);
  }
}

export const subagentTypes = new Map<string, SubagentType>();
export const subagentInstances = new Map<string, SubagentInstance>();

export type SubagentChangeListener = () => void;
export const subagentChangeListeners = new Set<SubagentChangeListener>();

export function subscribeToSubagents(listener: SubagentChangeListener) {
  subagentChangeListeners.add(listener);
  return () => {
    subagentChangeListeners.delete(listener);
  };
}

export function notifySubagentsChanged() {
  for (const listener of subagentChangeListeners) {
    listener();
  }
}

export function registerSubagentType(name: string, description: string, systemPrompt: string) {
  subagentTypes.set(name, { name, description, systemPrompt });
}

export let activeQuestionHandler: QuestionHandler | null = null;

export function registerQuestionHandler(handler: QuestionHandler | null) {
  activeQuestionHandler = handler;
}

export function getActiveQuestionHandler(): QuestionHandler | null {
  return activeQuestionHandler;
}
