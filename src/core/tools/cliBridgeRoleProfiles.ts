import type { AcceptanceContract } from "./cliBridgeAcceptance.js";
import type { ResourceClass } from "./cliBridgeScheduler.js";

export type RolePermissionMode =
  | "read-only"
  | "edit-no-shell"
  | "safe-shell"
  | "git-write"
  | "browser"
  | "full-auto";

export interface AgentRoleProfile {
  roleId: string;
  title: string;
  description: string;
  cliAlias: string;
  permissionMode: RolePermissionMode;
  resourceClass: ResourceClass;
  timeoutMs: number;
  worktreePolicy: "isolated" | "shared-read" | "in-place";
  systemInstructions: string;
  defaultAcceptance?: AcceptanceContract;
  envAllowList?: string[];
  maxRetries: number;
}

const BUILTIN_ROLE_PROFILES: Record<string, AgentRoleProfile> = {
  architect: {
    roleId: "architect",
    title: "System Architect",
    description: "Analyzes requirements, designs modular architectures, and formulates implementation plans.",
    cliAlias: "agy",
    permissionMode: "read-only",
    resourceClass: "light",
    timeoutMs: 60000,
    worktreePolicy: "shared-read",
    systemInstructions:
      "You are a Senior System Architect. Analyze codebase structures, invariants, and create rigorous, bite-sized implementation specs. Do not mutate files.",
    maxRetries: 1,
  },
  coder: {
    roleId: "coder",
    title: "Software Engineer",
    description: "Implements features, bugfixes, and refactors within an isolated git worktree.",
    cliAlias: "agy",
    permissionMode: "git-write",
    resourceClass: "normal",
    timeoutMs: 180000,
    worktreePolicy: "isolated",
    systemInstructions:
      "You are a Precision Software Engineer. Implement exact, idiomatic changes within your designated workspace. Adhere strictly to project conventions and tests.",
    maxRetries: 2,
  },
  tester: {
    roleId: "tester",
    title: "Test Automation Engineer",
    description: "Runs and develops unit, regression, and integration tests to verify implementation correctness.",
    cliAlias: "agy",
    permissionMode: "safe-shell",
    resourceClass: "heavy",
    timeoutMs: 120000,
    worktreePolicy: "isolated",
    systemInstructions:
      "You are a Rigorous Test Engineer. Execute test suites, assert concrete evidence, and report failing test cases with stack traces.",
    maxRetries: 1,
  },
  reviewer: {
    roleId: "reviewer",
    title: "Code & Security Reviewer",
    description: "Evaluates patches and diffs against architectural requirements, security boundaries, and code health.",
    cliAlias: "agy",
    permissionMode: "read-only",
    resourceClass: "light",
    timeoutMs: 60000,
    worktreePolicy: "shared-read",
    systemInstructions:
      "You are a Critical Code Reviewer. Inspect proposed diffs and verification evidence. Return a structured verdict: approve, request_changes, or reject with precise reasons.",
    maxRetries: 0,
  },
  researcher: {
    roleId: "researcher",
    title: "Codebase Researcher",
    description: "Explores repositories, traces lineages, and gathers references without mutating workspace state.",
    cliAlias: "agy",
    permissionMode: "read-only",
    resourceClass: "light",
    timeoutMs: 60000,
    worktreePolicy: "shared-read",
    systemInstructions:
      "You are a Technical Researcher. Search documentation, identify existing patterns, and provide comprehensive citations.",
    maxRetries: 1,
  },
};

const customProfiles = new Map<string, AgentRoleProfile>();

export function getRoleProfile(roleId: string): AgentRoleProfile | undefined {
  return customProfiles.get(roleId) || BUILTIN_ROLE_PROFILES[roleId];
}

export function registerRoleProfile(profile: AgentRoleProfile): void {
  customProfiles.set(profile.roleId, profile);
}

export function listRoleProfiles(): AgentRoleProfile[] {
  const all = { ...BUILTIN_ROLE_PROFILES };
  for (const [id, prof] of customProfiles.entries()) {
    all[id] = prof;
  }
  return Object.values(all);
}
