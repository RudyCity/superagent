export type NormalizedAgentEventType =
  | "init"
  | "planning"
  | "reading"
  | "editing"
  | "shell"
  | "tool_call"
  | "waiting_permission"
  | "testing"
  | "result"
  | "error";

export interface NormalizedAgentEvent {
  type: NormalizedAgentEventType;
  timestamp: number;
  message: string;
  payload?: any;
}

export interface AdapterCapabilities {
  cliAlias: string;
  structuredStream: boolean;
  interactiveResume: boolean;
  permissionModes: string[];
  tokenReporting: boolean;
  imageSupport: boolean;
}

export interface CliInvocationSpec {
  args: string[];
  env: Record<string, string>;
}

export interface ICliAdapter {
  readonly capabilities: AdapterCapabilities;
  buildInvocationArgs(opts: {
    prompt: string;
    permissionMode?: string;
    cwd: string;
    resumeId?: string;
    extraArgs?: string[];
    envAllowList?: string[];
  }): CliInvocationSpec;
  parseEventStreamLine(line: string): NormalizedAgentEvent | null;
}

export const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "SYSTEMROOT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "HOME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
];

export function buildFilteredEnvironment(customAllow?: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  const allowSet = new Set([...DEFAULT_ENV_ALLOWLIST, ...(customAllow || [])]);

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowSet.has(key)) {
      env[key] = value;
    }
  }

  return env;
}

export class AgyAdapter implements ICliAdapter {
  public readonly capabilities: AdapterCapabilities = {
    cliAlias: "agy",
    structuredStream: true,
    interactiveResume: true,
    permissionModes: ["plan", "accept-edits", "auto", "full-auto"],
    tokenReporting: true,
    imageSupport: false,
  };

  public buildInvocationArgs(opts: {
    prompt: string;
    permissionMode?: string;
    cwd: string;
    resumeId?: string;
    extraArgs?: string[];
    envAllowList?: string[];
  }): CliInvocationSpec {
    const args: string[] = [];

    // Map permission modes to AGY flags
    const mode = opts.permissionMode || "auto";
    if (mode === "plan" || mode === "read-only") {
      args.push("--mode", "plan");
    } else if (mode === "accept-edits" || mode === "edit-no-shell") {
      args.push("--mode", "accept-edits");
    } else if (mode === "full-auto") {
      args.push("--mode", "full-auto");
    } else {
      args.push("--mode", "auto");
    }

    if (opts.resumeId) {
      args.push("--resume", opts.resumeId);
    }

    if (opts.extraArgs && opts.extraArgs.length > 0) {
      args.push(...opts.extraArgs);
    }

    args.push("-p", opts.prompt);

    const env = buildFilteredEnvironment(opts.envAllowList);
    return { args, env };
  }

  public parseEventStreamLine(line: string): NormalizedAgentEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const now = Date.now();

    // Check for AGY permission block indicator
    if (trimmed.includes("[PERM_BLOCK]") || trimmed.includes("permission denied")) {
      return {
        type: "waiting_permission",
        timestamp: now,
        message: trimmed,
      };
    }

    // Check for planning / thinking indicator
    if (trimmed.startsWith("[plan]") || trimmed.startsWith("Thinking:")) {
      return {
        type: "planning",
        timestamp: now,
        message: trimmed,
      };
    }

    // Check for file edit indicator
    if (trimmed.includes("write_file") || trimmed.includes("edit_file") || trimmed.includes("patch")) {
      return {
        type: "editing",
        timestamp: now,
        message: trimmed,
      };
    }

    // Check for tool call
    if (trimmed.startsWith("Tool:") || trimmed.startsWith("Call:")) {
      return {
        type: "tool_call",
        timestamp: now,
        message: trimmed,
      };
    }

    // Check for test execution
    if (trimmed.includes("bun test") || trimmed.includes("vitest") || trimmed.includes("npm test")) {
      return {
        type: "testing",
        timestamp: now,
        message: trimmed,
      };
    }

    // Default result or planning event
    return {
      type: "planning",
      timestamp: now,
      message: trimmed,
    };
  }
}

export class ClaudeAdapter implements ICliAdapter {
  public readonly capabilities: AdapterCapabilities = {
    cliAlias: "claude",
    structuredStream: true,
    interactiveResume: true,
    permissionModes: ["read-only", "auto"],
    tokenReporting: true,
    imageSupport: false,
  };

  public buildInvocationArgs(opts: {
    prompt: string;
    permissionMode?: string;
    cwd: string;
    resumeId?: string;
    extraArgs?: string[];
    envAllowList?: string[];
  }): CliInvocationSpec {
    const args: string[] = ["-p", opts.prompt];
    if (opts.resumeId) {
      args.push("--continue", opts.resumeId);
    }
    if (opts.extraArgs) {
      args.push(...opts.extraArgs);
    }
    const env = buildFilteredEnvironment(opts.envAllowList);
    return { args, env };
  }

  public parseEventStreamLine(line: string): NormalizedAgentEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    return {
      type: "planning",
      timestamp: Date.now(),
      message: trimmed,
    };
  }
}

export class CodexAdapter implements ICliAdapter {
  public readonly capabilities: AdapterCapabilities = {
    cliAlias: "codex",
    structuredStream: false,
    interactiveResume: false,
    permissionModes: ["auto"],
    tokenReporting: false,
    imageSupport: false,
  };

  public buildInvocationArgs(opts: {
    prompt: string;
    permissionMode?: string;
    cwd: string;
    extraArgs?: string[];
    envAllowList?: string[];
  }): CliInvocationSpec {
    const args: string[] = ["exec", "--skip-git-repo-check", opts.prompt];
    if (opts.extraArgs) {
      args.push(...opts.extraArgs);
    }
    const env = buildFilteredEnvironment(opts.envAllowList);
    return { args, env };
  }

  public parseEventStreamLine(line: string): NormalizedAgentEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    return {
      type: "planning",
      timestamp: Date.now(),
      message: trimmed,
    };
  }
}

const adapterRegistry = new Map<string, ICliAdapter>([
  ["agy", new AgyAdapter()],
  ["claude", new ClaudeAdapter()],
  ["codex", new CodexAdapter()],
]);

export function getCliAdapter(alias: string): ICliAdapter {
  const norm = alias.toLowerCase().trim();
  const adapter = adapterRegistry.get(norm);
  if (!adapter) {
    throw new Error(`Unknown CLI adapter alias '${alias}'. Supported adapters: ${[...adapterRegistry.keys()].join(", ")}`);
  }
  return adapter;
}

export function registerCliAdapter(alias: string, adapter: ICliAdapter): void {
  adapterRegistry.set(alias.toLowerCase(), adapter);
}

export function listCliAdapters(): ICliAdapter[] {
  return [...adapterRegistry.values()];
}
