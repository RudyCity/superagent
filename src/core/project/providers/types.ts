import type { RegisteredProject } from "../projectRegistry.js";
import type { ProjectResolutionSource } from "../projectRouter.js";

export type ProjectProviderKind = "local" | "ssh";
export type ProjectOperation = "workspace_info" | "health_check" | "read_files" | "list_files" | "grep_search" | "find_files" | "write_files" | "exec_command" | "git_action";
export type ProjectHealthCheckStatus = "passed" | "failed" | "skipped";
export type ProjectHealthStatus = "healthy" | "degraded" | "unavailable";

export interface ProjectHealthCheck {
  name: string;
  status: ProjectHealthCheckStatus;
  message: string;
  durationMs: number;
}

export interface ProjectHealthReport {
  projectId: string;
  providerKind: ProjectProviderKind;
  status: ProjectHealthStatus;
  checkedAt: string;
  durationMs: number;
  checks: ProjectHealthCheck[];
  remediationHints: string[];
}

export interface ProjectHealthOptions {
  timeoutMs?: number;
}

export interface ResolvedProjectContext {
  projectId: string;
  providerKind: ProjectProviderKind;
  project: RegisteredProject;
  workspace: string;
  selectionSource: ProjectResolutionSource;
  explicit: boolean;
}

export interface ProjectWorkspaceInfo {
  projectId: string;
  providerKind: ProjectProviderKind;
  workspace: string;
  root: string;
  remote: boolean;
  exists: boolean;
  gitBranch?: string;
}

export interface ProjectOperationResult {
  text: string;
  isError?: boolean;
}

export type ProjectToolArguments = Record<string, unknown>;

export interface ProjectProvider {
  readonly kind: ProjectProviderKind;
  supports(operation: ProjectOperation): boolean;
  getWorkspaceInfo(context: ResolvedProjectContext): Promise<ProjectWorkspaceInfo>;
  checkHealth(context: ResolvedProjectContext, options?: ProjectHealthOptions): Promise<ProjectHealthReport>;
  readFiles(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult>;
  listFiles(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult>;
  grepSearch(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult>;
  findFiles(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult>;
  writeFiles(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult>;
  execCommand(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult>;
  gitAction(context: ResolvedProjectContext, args: ProjectToolArguments): Promise<ProjectOperationResult>;
  closeProject(projectId: string): Promise<void>;
}
