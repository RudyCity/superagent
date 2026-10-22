import type { Message } from "../conversation.js";
import { contentToString } from "../conversation.js";

/** Build a stable skill-search query from the latest request, not old topics. */
export function getCurrentSkillQuery(messages: Message[]): string {
  const userRequests = messages.filter((m) => m.role === "user").map((m) => contentToString(m.content).trim()).filter(Boolean);
  const latest = userRequests.at(-1) || "";
  if (/^(?:lanjut|lanjutkan|continue|resume|go ahead|proceed|oke|ok|yes|iya|sip|gas|terus)[.!\s]*$/i.test(latest) && userRequests.length > 1) {
    return userRequests[userRequests.length - 2] + " " + latest;
  }
  return latest;
}

/** Keep operational instructions focused on the active mode. */
export function getModeGuidance(mode: string, canSwitchMode: boolean): string {
  const descriptions: Record<string, string> = {
    ask: "Answer directly. Inspect files/search only when evidence is needed. Do not edit or execute mutating commands.",
    research: "Explore with read/search tools, cite evidence, and avoid mutations.",
    plan: "Prepare the requested plan with manage_plan; do not edit until approval.",
    implement: "Implement authorized changes; validate affected code and report evidence and remaining issues.",
    debug: "Investigate root cause, apply the smallest safe fix, test impacted paths, and report findings.",
    review: "Review with severity and file:line evidence; edit only if the user requests changes.",
  };
  const switchNotice = canSwitchMode
    ? "\n- If the selected mode blocks a user-requested action, use switch_mode; permissions still apply."
    : "";
  return "\n# ACTIVE MODE: " + mode + "\n" + (descriptions[mode] || descriptions.implement) + switchNotice;
}

/** Discovery is conditional: never tell the model to call tools it cannot see. */
export function getToolDiscoveryGuidance(tier: string, toolNames: string[], mode = "implement"): string {
  if (!["master", "single", "superagent"].includes(tier) || !toolNames.includes("describe_tool")) return "";
  if (mode === "ask") return ["# TOOL ACCESS", "- If evidence needs tools, describe_tool known names first." + (toolNames.includes("list_tools") ? " Use list_tools with one keyword only if names are unknown." : "") + " Only authorized tools; avoid unnecessary calls."].join(String.fromCharCode(10));
  const listNotice = toolNames.includes("list_tools")
    ? "\n- For unknown capabilities, call list_tools({intent: task_summary}) for a short ranked list. Use query for one keyword or omit it for the catalog."
    : "";
  return "\n# TOOL DISCOVERY"
    + "\n- Call describe_tool({names:[\"tool1\",\"tool2\"]}) once for known tools. Invoke only authorized/described tools; discovery is not permission."
    + listNotice
    + "\n- File calls require arrays, even for one item: read({filePaths:[\"path\"]}), write_to_file({files:[{filePath,content}]}), replace_file_content({edits:[{filePath,targetContent,replacementContent,startLine,endLine}]}), apply_patch({patches:[{filePath,patchContent}]})."
    + "\n- Batch independent operations; serialize stateful and conflicting edits. Do not rediscover an already described tool.";
}

export function getExecutionGuidance(maxIterations: string, canDelegate: boolean, goalMode: boolean): string {
  let text = "\n# EXECUTION AND STOP"
    + "\n- Iteration limit: " + maxIterations + ". Stop when the request is answered or the result verified; a synthetic task marker alone is not an unfinished objective."
    + "\n- Do not repeat unchanged tool calls or answers. If blocked or the loop guard stops execution, report incomplete with evidence."
    + "\n- Never claim edits, tests, external actions, or builds succeeded without observed results.";
  if (canDelegate) text += "\n- Delegate independent substantial work when useful; verify subagent results before completion.";
  if (goalMode) text += "\n- GOAL MODE: Verify success and emit GOAL_COMPLETE; when blocked or safety-limited, emit GOAL_PARTIAL with evidence. Never override loop guards.";
  return text;
}

export function shouldIncludePlanningContext(category: string, planState: string, destructive: boolean, goalMode: boolean): boolean {
  if (destructive || goalMode || planState === "PLANNING_PENDING") return true;
  return !["question", "conversation"].includes(category);
}
