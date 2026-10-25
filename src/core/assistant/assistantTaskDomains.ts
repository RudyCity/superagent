/** Explicit, persistent T-Line assistant task domains.
 * Domain selection is a capability boundary, not a keyword-based trust upgrade.
 * No unattended domain is permitted shell, browser control, file writes or
 * external account mutations. Unsupported modes remain visible as planned.
 */
export const ASSISTANT_TASK_DOMAINS = [
  "general", "research", "analysis", "planning", "files", "coding",
] as const;
export type AssistantTaskDomain = typeof ASSISTANT_TASK_DOMAINS[number];
export const DEFAULT_ASSISTANT_TASK_DOMAIN: AssistantTaskDomain = "analysis";
export const TASK_DOMAIN_DESCRIPTORS: ReadonlyArray<{
  id: AssistantTaskDomain; label: string; description: string;
  toolNames: readonly string[]; patchPreview: boolean;
}> = [
  { id: "general", label: "General Assistant",
    description: "Questions, explanations, brainstorming and conversation support",
    toolNames: [], patchPreview: false },
  { id: "research", label: "Research",
    description: "Web information gathering, source comparison and synthesis",
    toolNames: ["web_search", "fetch_url"], patchPreview: false },
  { id: "analysis", label: "Analysis",
    description: "Inspect workspace context and reason about findings",
    toolNames: ["read", "glob", "grep", "ripgrep_search", "read_document", "git_status", "git_diff"],
    patchPreview: false },
  { id: "planning", label: "Planning",
    description: "Plans, outlines, decisions and next-step recommendations",
    toolNames: [], patchPreview: false },
  { id: "files", label: "Files & Documents",
    description: "Read and summarize local files, no changes to disk",
    toolNames: ["read", "glob", "grep", "ripgrep_search", "read_document"],
    patchPreview: false },
  { id: "coding", label: "Coding",
    description: "Read code and prepare isolated patch proposals after confirmation",
    toolNames: ["read", "glob", "grep", "ripgrep_search", "git_status", "git_diff"],
    patchPreview: true },
];
export function validAssistantTaskDomain(value: unknown): value is AssistantTaskDomain {
  return typeof value === "string" &&
    (ASSISTANT_TASK_DOMAINS as readonly string[]).includes(value);
}
export function getAssistantTaskDomain(value: unknown) {
  if (!validAssistantTaskDomain(value)) throw new Error("Invalid assistant task domain");
  const domain = TASK_DOMAIN_DESCRIPTORS.find(item => item.id === value);
  if (!domain) throw new Error("Unsupported assistant task domain");
  return domain;
}
export function taskDomainPrompt(domain: AssistantTaskDomain, title: string): string {
  const prefix: Record<AssistantTaskDomain, string> = {
    general: "Act as a helpful general-purpose assistant. Provide a grounded and direct answer. ",
    research: "Research the request using approved search and retrieval tools where useful. Cite source URLs when available. ",
    analysis: "Analyze the request carefully; inspect only relevant readable project context. ",
    planning: "Produce a practical plan, dependencies, risks, decisions, and concrete next steps. ",
    files: "Read and summarize relevant local documents safely. Do not modify files. ",
    coding: "Investigate source code and recommend improvements. Do not edit files, run commands or assert changes. ",
  };
  return prefix[domain] + "Task: " + title;
}
