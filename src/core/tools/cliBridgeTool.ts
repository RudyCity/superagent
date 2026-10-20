/**
 * cliBridgeTool.ts — `cli_bridge` agent tool.
 *
 * File-size note: at ~1010 lines this is just over the 1000-line soft
 * cap. Most of the growth came from the v1.5.17 additions
 * (handleSessionTail + handleSessionDetach + new params on
 * handleSessionCreate/Get/List). Further splits would force artificial
 * boundaries between per-action handlers; instead each handler is a
 * short, clearly-marked function and the helper section at the bottom
 * (formatAge, known CLIs, descriptor shape) is consolidated.
 *
 * Lets Superagent **delegate a task** to an external AI CLI assistant
 * (OpenAI Codex, Claude Code, Antigravity/AGY, or any custom binary) in two
 * complementary modes:
 *
 *   • **Synchronous** (action=delegate) — run a short task, wait for exit,
 *     and return captured output in the same MCP call.
 *
 *   • **Background job** (action=delegate.start) — start long-running work,
 *     return a jobId immediately, then poll output/status or cancel it.
 *     Multiple jobs may run concurrently within a bounded process limit.
 *
 *   • **Session** (action=session.*) — spawn the CLI as a long-lived
 *     subprocess, send multiple messages, kill when done. Useful for
 *     multi-turn collaboration (chat-style, context-preserving).
 *
 * Why this exists: Superagent can offload sub-tasks to a *different* model
 * running in a separate CLI process — different system prompt, different
 * context, different strengths — and merge the results without the user
 * ever leaving the terminal UI.
 *
 * Tier availability: `single` + `superagent` (NOT `master` — the master
 * orchestrates by delegating to superagents, not by spawning CLIs itself).
 */

import { Tool } from "./types.js";
import { getRootConfigDir } from "../config.js";
import {
  CliDescriptor,
  DelegateResult,
  detectAvailableClis,
  runDelegate,
  createSession,
  sendToSession,
  listSessions,
  getSession,
  killSession,
  knownCliDescriptors,
  SendResult,
  respondToSession,
  resumeSession,
  exportSession,
  ExportedSession,
  ResumeOpts,
  // v1.5.17
  tailEvents,
  getLastEventSeq,
  setIdleTimeout,
  detachSession,
  getSessionAny,
  listDetachedSessions,
  detachedSessionsFull,
  SessionEvent,
} from "./cliBridgeSession.js";
import {
  getProfile,
  loadProfiles,
  buildSessionArgv,
  buildSessionEnv,
  applyPromptTemplate,
  CliProfile,
  PROFILE_FILE_NAME,
} from "./cliBridgeProfiles.js";
import {
  resolveSkills,
  loadGlobalSkillRegistry,
  SKILL_REGISTRY_FILE_NAME,
  GlobalSkillRegistry,
} from "./cliBridgeSkills.js";
import { formatUnknownActionError } from "./helpers.js";
import {
  resolveArtifactPaths,
  buildArtifactContextBlock,
  summarizeTaskChecklist,
  ArtifactPaths,
} from "./cliBridgeArtifacts.js";
import fs from "fs";
import path from "path";
import { canonicalCliWorkspace, resolveAuthorizedDelegateCwd, delegateJobVisibleToWorkspace, cliSessionVisibleToWorkspace, cliArtifactPathVisibleToWorkspace } from "./cliBridgeWorkspaceScope.js";
import {
  startDelegateJob,
  listDelegateJobs,
  getDelegateJob,
  tailDelegateJob,
  cancelDelegateJob,
} from "./cliBridgeDelegateJobs.js";

// ─── Tool definition ─────────────────────────────────────────────────────

const ACTIONS = [
  "list",
  "delegate",
  "delegate.start",
  "delegate.jobs",
  "delegate.get",
  "delegate.tail",
  "delegate.cancel",
  "session.create",
  "session.send",
  "session.list",
  "session.kill",
  "session.get",
  "session.resume",
  "session.respond",
  "session.export",
  "session.config",
  "session.tail",   // v1.5.17
  "session.detach", // v1.5.17
  "profile.list",
] as const;

type Action = (typeof ACTIONS)[number];

export const cliBridgeTool: Tool = {
  name: "cli_bridge",
  description:
    "Delegate a task to an external AI CLI assistant (Codex, Claude Code, AGY, or any custom binary). " +
    "Three modes: (1) `delegate` for short synchronous tasks, (2) `delegate.start` plus `delegate.get`/`delegate.tail`/`delegate.cancel` for long-running background jobs and bounded parallel work, (3) `session.*` for interactive multi-turn sessions. " +
    "Use `list` to discover installed CLIs, `delegate` for all autonomous coding/analysis tasks, and `session.create`+`session.send`+`session.kill` only when interactive step-by-step TUI dialog is required. " +
    "Long-running MCP support: delegate.start returns a background job id; delegate.jobs lists jobs; delegate.get and delegate.tail poll progress/output; delegate.cancel requests cancellation. Multiple jobs can run concurrently. " +
    "Use delegate for short tasks and delegate.start for builds or lengthy edits so the MCP request does not have to remain open. " +
    "v1.5.17: `session.create` can auto-send an initial prompt the moment the session is ready, " +
    "sessions auto-kill after an idle TTL (idleTimeoutMs, default 30 min), " +
    "stdout/stderr buffers are capped per-session (maxBufferLines, default 2000), " +
    "live events stream via `session.tail` (with optional `setIdleTimeoutMs` to extend the TTL), " +
    "and `session.detach` releases a session without killing the child process. " +
    "v1.5.15: handles interactive TUI prompts (yes/no, password, choice) via session.respond, supports per-CLI profiles (resume, skills, env), plus session.resume, session.export, and profile.list.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        description:
          "Operation: 'list'/'profile.list' to discover CLIs/profiles, " +
          "'delegate' for short synchronous autonomous tasks, " +
          "'delegate.start' for long-running background tasks that return a jobId immediately (default 30 minutes; up to 2 hours), " +
          "'delegate.jobs' to list concurrent jobs, 'delegate.get' to inspect status/output, 'delegate.tail' to read recent logs, and 'delegate.cancel' to stop a job. " +
          "The default concurrency limit is 4 jobs (configure with SUPERAGENT_CLI_BRIDGE_MAX_JOBS, max 12). Use separate worktrees/cwds for parallel code edits to avoid file conflicts. " +
          "'session.create' to start an interactive multi-turn session (optionally with initial `message` to auto-send once ready), " +
          "'session.send' to message it, " +
          "'session.respond' to answer a pending prompt, " +
          "'session.tail' to stream/read the session's event log (with optional `setIdleTimeoutMs`), " +
          "'session.detach' to release the session without killing the child process, " +
          "'session.resume' to re-attach, " +
          "'session.list' to see active and detached sessions, 'session.get' to inspect one, " +
          "'session.export' to dump state, 'session.config' to see the profile, " +
          "'session.kill' to terminate.",
      },
      cli: {
        type: "string",
        description:
          "CLI alias (for delegate/session.create): 'codex', 'claude', 'agy', " +
          "or 'custom' (then set 'binary' to the absolute path of any other executable).",
      },
      binary: {
        type: "string",
        description:
          "Absolute path to a custom binary. Required only when cli='custom'. " +
          "Example: 'C:\\\\Users\\\\me\\\\bin\\\\aider' or '/usr/local/bin/aider'.",
      },
      prompt: {
        type: "string",
        description: "Prompt text to send to the CLI (for action=delegate).",
      },
      message: {
        type: "string",
        description:
          "Message text. For action=session.send this is the message body. " +
          "For action=session.create this is the INITIAL prompt that will be auto-sent " +
          "as soon as the session becomes ready (v1.5.17).",
      },
      initialMessage: {
        type: "string",
        description:
          "v1.5.17: alias for 'message' on action=session.create. If supplied, the " +
          "prompt is auto-sent once the session is ready. Use this when you want to " +
          "create a session AND fire its first prompt in a single call.",
      },
      sessionId: {
        type: "string",
        description: "Target session id (for session.send / session.kill / session.get).",
      },
      jobId: {
        type: "string",
        description: "Background delegation id returned by delegate.start (for delegate.get / delegate.tail / delegate.cancel).",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description:
          "Extra CLI args to prepend before the prompt (for action=delegate) " +
          "or as the initial argv (for action=session.create).",
      },
      skills: {
        type: "array",
        items: { type: "string" },
        description:
          "Skills to attach. Each item can be either a filesystem path " +
          "(e.g. /abs/path/skills/frontend) OR a name looked up in the " +
          "profile's skillsRegistry / global skill registry " +
          "(~/.superagent-r/cli-bridge/skills.json). " +
          "Translated to per-CLI flags via the profile: " +
          "`--add-dir` for AGY/Claude Code (repeatable), `--cd` for Codex (single). " +
          "Auto-detect also runs: AGENTS.md/CLAUDE.md/AGY.md/CODEX.md at cwd are " +
          "added automatically (use skillAutoDetect=false to disable).",
      },
      skillAutoDetect: {
        type: "boolean",
        description:
          "If true (default), auto-include AGENTS.md, AGENTS.local.md, CLAUDE.md, " +
          "AGY.md, CODEX.md found at the session's cwd. Set to false to disable.",
      },
      system: {
        type: "string",
        description:
          "System prompt prepended to the user's prompt. Applied via the profile's " +
          "defaultPromptTemplate (default: '{system}\\n\\n{prompt}'). " +
          "Use to set role, constraints, or output format for the external CLI " +
          "(e.g. 'You are a senior reviewer. Reply in JSON only.').",
      },
      // ─── v1.5.40 ─────────────────────────────────────────────
      injectArtifacts: {
        type: "boolean",
        description:
          "v1.5.40: If true (default), automatically resolves and injects paths to active task checklist, " +
          "implementation plan, and walkthrough files into the prompt so the external AI CLI can inspect and update them.",
      },
      taskPath: {
        type: "string",
        description: "Optional explicit file path to the task checklist (e.g. task.md or _task.md) to override auto-detection.",
      },
      planPath: {
        type: "string",
        description: "Optional explicit file path to the implementation plan (e.g. plan.md or _plan.md) to override auto-detection.",
      },
      walkthroughPath: {
        type: "string",
        description: "Optional explicit file path to the walkthrough document (e.g. walkthrough.md or _walkthrough.md) to override auto-detection.",
      },
      // ─── v1.5.17 ─────────────────────────────────────────────
      idleTimeoutMs: {
        type: "number",
        description:
          "v1.5.17: idle TTL in ms. The session is auto-killed if it produces no output for this " +
          "many ms. 0 disables. Default: 30 min. Can be set per session on session.create, " +
          "and adjusted later via setIdleTimeout.",
      },
      setIdleTimeoutMs: {
        type: "number",
        description:
          "v1.5.17: if supplied (with sessionId), updates the idle TTL of an existing session " +
          "and returns the new value. Use this to extend a session that is about to start a " +
          "long-running operation (e.g. a big build).",
      },
      maxBufferLines: {
        type: "number",
        description:
          "v1.5.17: maximum lines kept in the per-session stdout/stderr buffer. Default: 2000. " +
          "Once exceeded, the oldest lines are dropped.",
      },
      autoSendInitial: {
        type: "boolean",
        description:
          "v1.5.17: on session.create, if true (default) and an initialMessage is provided, " +
          "the message is auto-sent as soon as the session is ready. Set false to only queue it.",
      },
      since: {
        type: "number",
        description:
          "v1.5.17: for action=session.tail, only return events with seq > since. " +
          "Use this to resume a stream after a disconnect.",
      },
      tailLimit: {
        type: "number",
        description:
          "Maximum trailing lines/events returned by action=session.tail or action=delegate.tail (default 200, capped at 2000).",
      },
      // ─────────────────────────────────────────────────────────
      conversationId: {
        type: "string",
        description:
          "Conversation id to bind to the session (for session.create / session.resume). " +
          "Use session.export to retrieve from a previous session. The CLI itself restores the context.",
      },
      env: {
        type: "object",
        description:
          "Extra environment variables for the session, e.g. env={\"OPENAI_API_KEY\":\"sk-...\"}. " +
          "Merged on top of the profile's passthrough list.",
      },
      cwd: {
        type: "string",
        description: "Working directory for the session. Defaults to the agent's cwd.",
      },
      interactive: {
        type: "boolean",
        description:
          "If true (and the profile defines an interactiveFlag), start the CLI in interactive mode " +
          "(e.g. agy -i). Useful when the user wants a TUI to chat with the external CLI directly.",
      },
      answer: {
        type: "string",
        description: "Answer to a pending interactive prompt (for action=session.respond).",
      },
      tailLines: {
        type: "number",
        description: "Maximum trailing lines included by action=session.export (default 200).",
      },
      expectedArtifacts: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional action=delegate.start only: 1-12 relative file paths inside the delegated working directory. " +
          "After exit 0, every file must be newly created or content-changed (SHA-256 compared against a pre-run baseline). " +
          "Missing, unchanged, escaped, oversized or symlinked files do not count as verified completion. " +
          "Without expectedArtifacts, exit 0 is an unverified process success, not proof of task completion.",
      },
      timeoutMs: {
        type: "number",
        description:
          "Timeout in milliseconds. Defaults: 300_000 for blocking delegate, 1_800_000 (30 minutes) for delegate.start, and 120_000 for session.send. Delegation timeout range is 1000..7200000 (2 hours). Background jobs are polled by job id without keeping the MCP request open.",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = String(args.action ?? "") as Action;
    if (!action) {
      return formatUnknownActionError("", [...ACTIONS]);
    }
    if (!ACTIONS.includes(action)) {
      return formatUnknownActionError(action, [...ACTIONS]);
    }

    try {
      // All session mutations and reads use the same identity boundary.
      // A leaked/guessed sessionId must never authorize access to another project.
      if (action.startsWith("session.") && action !== "session.create" && action !== "session.list") {
        const id = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
        if (id) {
          const candidate = getSessionAny(id);
          if (candidate && !cliSessionVisibleToWorkspace(candidate, cwd)) {
            return "Error: CLI Bridge session not found in the authorized workspace.";
          }
        }
      }
      switch (action) {
        case "list":
          return await handleList();

        case "delegate":
          return await handleDelegate(args, cwd, signal);

        case "delegate.start":
          return await handleDelegate({ ...args, __background: true }, cwd, signal);

        case "delegate.jobs":
          return await handleDelegateJobs(cwd);

        case "delegate.get":
          return await handleDelegateGet(String(args.jobId ?? "").trim(), cwd);

        case "delegate.tail":
          return await handleDelegateTail(String(args.jobId ?? "").trim(), args.tailLimit === undefined ? 200 : Number(args.tailLimit), cwd);

        case "delegate.cancel":
          return await handleDelegateCancel(String(args.jobId ?? "").trim(), cwd);

        case "session.create":
          return await handleSessionCreate(args, cwd);

        case "session.send":
          return await handleSessionSend(args);

        case "session.list":
          return handleSessionList(cwd);

        case "session.get":
          return handleSessionGet(String(args.sessionId ?? ""));

        case "session.kill":
          return handleSessionKill(String(args.sessionId ?? ""));

        case "session.resume":
          return await handleSessionResume(args, cwd);

        case "session.respond":
          return await handleSessionRespond(args);

        case "session.export":
          return handleSessionExport(args);

        case "session.config":
          return handleSessionConfig(String(args.sessionId ?? ""));

        case "session.tail":
          return handleSessionTail(args);

        case "session.detach":
          return handleSessionDetach(String(args.sessionId ?? ""));

        case "profile.list":
          return handleProfileList();

        default:
          return formatUnknownActionError(action, [...ACTIONS]);
      }
    } catch (err) {
      // AbortError from the harness — re-throw so the agent loop can handle it.
      if (signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "CancelError"))) {
        const a = new Error("AbortError");
        a.name = "AbortError";
        throw a;
      }
      const message = err instanceof Error ? err.message : String(err);
      return `cli_bridge error: ${message}`;
    }
  },
};

// ─── Action handlers ─────────────────────────────────────────────────────

async function handleList(): Promise<string> {
  const all = await detectAvailableClis();
  const available = all.filter((d) => d.available);
  const missing = all.filter((d) => !d.available);

  const lines: string[] = [];
  lines.push(`Detected ${available.length} of ${all.length} known AI CLIs on PATH:`);
  lines.push("");
  if (available.length > 0) {
    lines.push("Available:");
    for (const d of available) {
      lines.push(`  • ${d.alias.padEnd(8)} ${d.label}`);
      lines.push(`             binary: ${d.binary}`);
    }
  } else {
    lines.push("Available: (none)");
  }
  lines.push("");
  if (missing.length > 0) {
    lines.push("Not installed:");
    for (const d of missing) {
      lines.push(`  • ${d.alias.padEnd(8)} ${d.label}`);
      if (d.installHint) lines.push(`             ${d.installHint}`);
    }
    lines.push("");
    lines.push("Tip: you can still use cli='custom' with binary='<absolute path>' for any other CLI.");
  }
  // Also include a JSON block for easier LLM consumption.
  lines.push("");
  lines.push("JSON:");
  lines.push(JSON.stringify(all.map(serializeDescriptor), null, 2));
  return lines.join("\n");
}

function serializeDescriptor(d: CliDescriptor): Record<string, unknown> {
  return {
    alias: d.alias,
    label: d.label,
    binary: d.binary,
    available: d.available,
    installHint: d.installHint,
  };
}

function resolveScopedCliArtifacts(
  callerWorkspace: string,
  selectedCwd: string,
  args: Record<string, unknown>,
): ArtifactPaths {
  const paths = resolveArtifactPaths(selectedCwd, {
    taskPath: args.taskPath ? String(args.taskPath) : undefined,
    planPath: args.planPath ? String(args.planPath) : undefined,
    walkthroughPath: args.walkthroughPath ? String(args.walkthroughPath) : undefined,
    provideDefaultTargets: Boolean(args.provideDefaultTargets ?? (args.taskPath || args.planPath || args.walkthroughPath)),
  });
  for (const [pathKey, existsKey] of [
    ["taskPath", "taskExists"], ["planPath", "planExists"], ["walkthroughPath", "walkthroughExists"],
  ] as const) {
    const candidate = paths[pathKey];
    if (!candidate || cliArtifactPathVisibleToWorkspace(candidate, callerWorkspace)) continue;
    if (args[pathKey] !== undefined) {
      throw new Error("CLI Bridge artifact path is outside the authorized workspace.");
    }
    // Session-file fallbacks from another project are never injected into prompts.
    delete paths[pathKey];
    delete paths[existsKey];
  }
  return paths;
}

async function handleDelegate(
  args: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) {
    return "Error: 'prompt' is required for action=delegate.";
  }
  const cliAlias = String(args.cli ?? "").trim();
  if (!cliAlias) {
    return "Error: 'cli' is required for action=delegate (e.g. cli='agy', cli='codex', cli='claude', cli='custom').";
  }

  const desc = await resolveDescriptor(cliAlias, args.binary);
  if (!desc) {
    return `Error: CLI '${cliAlias}' is not available. Run action=list to see what's installed.`;
  }

  const extraArgs = (args.args as string[] | undefined) ?? [];
  const isBackground = args.__background === true;
  if (args.expectedArtifacts !== undefined && !isBackground) {
    return "Error: expectedArtifacts currently requires action=delegate.start; blocking delegate has no artifact proof gate.";
  }
  let timeoutMs: number | undefined;
  if (args.timeoutMs !== undefined && args.timeoutMs !== null) {
    const requestedTimeout = Number(args.timeoutMs);
    if (!Number.isFinite(requestedTimeout) || requestedTimeout < 1000 || requestedTimeout > 7200000) {
      return "Error: timeoutMs must be between 1000 and 7200000 (2 hours). Use action=delegate.start for long-running work that can be polled without keeping the MCP request open.";
    }
    timeoutMs = requestedTimeout;
  }
  if (isBackground && timeoutMs === undefined) timeoutMs = 30 * 60 * 1000;
  const delegateCwd = resolveAuthorizedDelegateCwd(cwd, args.cwd ? String(args.cwd) : undefined);

  // Resolve skills directories/profiles for 1-shot execution:
  const profile = getProfile(desc.alias);
  const skillsRequested = (args.skills as string[] | undefined) ?? undefined;
  const autoDetect = args.skillAutoDetect !== false;
  const skillResolution = profile
    ? resolveSkills({
        requested: skillsRequested,
        profileRegistry: profile.skillsRegistry,
        autoDetect,
        cwd: delegateCwd,
      })
    : resolveSkills({
        requested: skillsRequested,
        autoDetect,
        cwd: delegateCwd,
      });

  const skillsArgs: string[] = [];
  if (skillResolution.paths.length > 0 && profile?.skillsArg) {
    const dirPaths = Array.from(
      new Set(
        skillResolution.paths.map((p) => {
          try {
            return fs.statSync(p).isDirectory() ? p : path.dirname(p);
          } catch {
            return p;
          }
        })
      )
    );
    if (profile.skillsRepeatable) {
      for (const p of dirPaths) {
        skillsArgs.push(`--${profile.skillsArg}`, p);
      }
    } else if (dirPaths.length > 0) {
      skillsArgs.push(`--${profile.skillsArg}`, dirPaths[0]);
    }
  }

  // v1.5.40: Resolve and inject active artifact paths (task, plan, walkthrough)
  const injectArtifacts = args.injectArtifacts !== false;
  let artifactContext = "";
  let activeArtifacts: ArtifactPaths | undefined;
  if (injectArtifacts) {
    activeArtifacts = resolveScopedCliArtifacts(cwd, delegateCwd, args);
    const block = buildArtifactContextBlock(activeArtifacts);
    if (block) {
      artifactContext = block;
    }
  }

  // v1.5.16: Apply the profile's prompt template with system (if any).
  const rawSystemPrompt = args.system ? String(args.system) : undefined;
  const fullSystemPrompt = artifactContext
    ? (rawSystemPrompt ? `${rawSystemPrompt}\n\n${artifactContext}` : artifactContext)
    : rawSystemPrompt;
  const tpl = profile?.defaultPromptTemplate ?? "{system}\n\n{prompt}";
  const composedPrompt = applyPromptTemplate(tpl, { system: fullSystemPrompt ?? "", prompt });

  // Resolve default args and prompt subcommands for 1-shot execution:
  const defaultFlags = profile?.defaultArgs ?? desc.defaultArgs ?? [];
  const promptSub = profile?.promptSubcommand ?? desc.promptSubcommand ?? [];
  const autoFlags = desc.alias === "agy" && !extraArgs.includes("--dangerously-skip-permissions")
    ? ["--dangerously-skip-permissions"]
    : [];
  
  // Note: promptSub (e.g. -p or --print) MUST be placed at the end so it immediately precedes the prompt
  // Do NOT dedupe skillsArgs via Set as it strips repeated flags like `--add-dir`.
  const flagSet = new Set<string>();
  const baseFlags: string[] = [];
  for (const f of [...defaultFlags, ...autoFlags]) {
    if (!flagSet.has(f)) {
      flagSet.add(f);
      baseFlags.push(f);
    }
  }
  const combinedArgs = [...baseFlags, ...skillsArgs, ...extraArgs, ...promptSub];

  if (isBackground) {
    if (signal?.aborted) {
      const abortError = new Error("AbortError");
      abortError.name = "AbortError";
      throw abortError;
    }
    const job = await startDelegateJob({
      cliAlias: desc.alias,
      binary: desc.binary,
      prompt: composedPrompt,
      cwd: delegateCwd,
      workspaceRoot: canonicalCliWorkspace(cwd),
      expectedArtifacts: args.expectedArtifacts as string[] | undefined,
      args: [...combinedArgs, composedPrompt],
      timeoutMs: timeoutMs ?? 30 * 60 * 1000,
    });
    return formatStartedDelegateJob(job, composedPrompt);
  }

  const result: DelegateResult = await runDelegate({
    cliAlias: desc.alias,
    binary: desc.binary,
    prompt: composedPrompt,
    cwd: delegateCwd,
    extraArgs: combinedArgs,
    timeoutMs,
    signal,
  });

  // v1.5.41: Notify listeners and UI that tasks may have changed on disk
  try {
    const { notifyTasksChanged } = await import("./state.js");
    notifyTasksChanged();
  } catch {}

  const taskSummary = activeArtifacts?.taskPath ? summarizeTaskChecklist(activeArtifacts.taskPath) : null;

  return formatDelegateResult(result, composedPrompt, combinedArgs, taskSummary?.formatted);
}

function formatDelegateResult(
  result: DelegateResult,
  prompt: string,
  extraArgs: string[],
  taskSummary?: string
): string {
  const lines: string[] = [];
  lines.push(`Delegated to ${result.cliAlias} (exit=${result.exitCode ?? "?"}, ${result.durationMs}ms${result.timedOut ? ", TIMED OUT" : ""})`);
  if (extraArgs.length > 0) {
    lines.push(`Extra args: ${JSON.stringify(extraArgs)}`);
  }
  lines.push(`Prompt (${prompt.length} chars): ${prompt.slice(0, 200)}${prompt.length > 200 ? "…" : ""}`);
  if (taskSummary) {
    lines.push(`Status: ${taskSummary}`);
  }
  lines.push("");
  lines.push("Output:");
  lines.push(result.output || "(no stdout)");
  if (result.stderr) {
    lines.push("");
    lines.push("Stderr:");
    lines.push(result.stderr);
  }
  lines.push("");
  lines.push(`Full log: ${result.logPath}`);
  return lines.join("\n");
}

function formatStartedDelegateJob(job: Awaited<ReturnType<typeof startDelegateJob>>, prompt: string): string {
  return [
    "Started background CLI delegation: " + job.jobId,
    "Status: " + job.status,
    "Completion proof: " + (job.completionState ?? "unverified"),
    "Expected artifacts: " + (job.expectedArtifacts?.join(", ") || "(none; exit 0 is not proof)"),
    "CLI: " + job.cliAlias + " | PID: " + (job.pid ?? "starting") + " | Timeout: " + job.timeoutMs + "ms",
    "Working directory: " + job.cwd,
    "Prompt: " + prompt.slice(0, 180) + (prompt.length > 180 ? "…" : ""),
    "Log: " + job.logPath,
    "",
    "Poll with action=delegate.get, jobId=" + job.jobId + ".",
    "Read the log tail with action=delegate.tail, jobId=" + job.jobId + ".",
    "Cancel with action=delegate.cancel, jobId=" + job.jobId + ".",
    "Multiple delegate.start jobs can run concurrently (default limit: 4).",
  ].join("\n");
}

async function handleDelegateJobs(callerWorkspace: string): Promise<string> {
  const jobs = (await listDelegateJobs()).filter(job => delegateJobVisibleToWorkspace(job, callerWorkspace));
  if (jobs.length === 0) return "No CLI Bridge background delegation jobs yet.";
  const lines = ["CLI Bridge background jobs (" + jobs.length + " retained):"];
  for (const job of jobs) {
    lines.push("- " + job.jobId + " | " + job.status + " | proof=" + (job.completionState ?? "unverified") + " | cli=" + job.cliAlias + " | pid=" + (job.pid ?? "-") + " | exit=" + (job.exitCode ?? "-") + " | duration=" + (job.durationMs ?? (Date.now() - job.startedAt)) + "ms");
    lines.push("  cwd: " + job.cwd);
    lines.push("  log: " + job.logPath);
  }
  return lines.join("\n");
}

async function handleDelegateGet(jobId: string, callerWorkspace: string): Promise<string> {
  if (!jobId) return "Error: 'jobId' is required for action=delegate.get.";
  const job = await getDelegateJob(jobId);
  if (!job || !delegateJobVisibleToWorkspace(job, callerWorkspace)) return "Error: delegation job not found in the authorized workspace.";
  return [
    "CLI Bridge job: " + job.jobId,
    "Status: " + job.status,
    "Completion proof: " + (job.completionState ?? "unverified"),
    "Artifact evidence: " + (job.artifactEvidence?.map(item =>
      [item.path, item.state, item.sha256 ? "sha256=" + item.sha256 : "", item.bytes === undefined ? "" : "bytes=" + item.bytes].filter(Boolean).join(" ")
    ).join("; ") || "(none)"),
    "CLI: " + job.cliAlias + " | PID: " + (job.pid ?? "-") + " | Exit: " + (job.exitCode ?? "-"),
    "Started: " + new Date(job.startedAt).toISOString(),
    "Duration: " + (job.durationMs ?? (Date.now() - job.startedAt)) + "ms" + (job.timedOut ? " (timed out)" : ""),
    "Timeout: " + job.timeoutMs + "ms",
    "Output bytes: " + job.outputBytes,
    "Working directory: " + job.cwd,
    "Log: " + job.logPath,
    job.error ? "Error: " + job.error : "",
    "",
    "Recent output:",
    job.outputTail || "(no output captured yet; use action=delegate.tail to read the log file)",
  ].filter(Boolean).join("\n");
}

async function handleDelegateTail(jobId: string, tailLimit: number, callerWorkspace: string): Promise<string> {
  if (!jobId) return "Error: 'jobId' is required for action=delegate.tail.";
  const job = await getDelegateJob(jobId);
  if (!job || !delegateJobVisibleToWorkspace(job, callerWorkspace)) return "Error: delegation job not found in the authorized workspace.";
  const result = await tailDelegateJob(jobId, Number.isFinite(tailLimit) ? tailLimit : 200);
  if (!result || !delegateJobVisibleToWorkspace(result.job, callerWorkspace)) return "Error: delegation job not found in the authorized workspace.";
  return ["CLI Bridge job " + jobId + " | status=" + result.job.status + " | proof=" + (result.job.completionState ?? "unverified") + " | exit=" + (result.job.exitCode ?? "-"), "Log: " + result.job.logPath, "", result.output].join("\n");
}

async function handleDelegateCancel(jobId: string, callerWorkspace: string): Promise<string> {
  if (!jobId) return "Error: 'jobId' is required for action=delegate.cancel.";
  const job = await getDelegateJob(jobId);
  if (!job || !delegateJobVisibleToWorkspace(job, callerWorkspace)) return "Error: delegation job not found in the authorized workspace.";
  const result = await cancelDelegateJob(jobId);
  return [result.message, result.job ? "Current status: " + result.job.status : ""].filter(Boolean).join("\n");
}

async function handleSessionCreate(
  args: Record<string, unknown>,
  cwd: string
): Promise<string> {
  const cliAlias = String(args.cli ?? "").trim();
  if (!cliAlias) {
    return "Error: 'cli' is required for action=session.create.";
  }
  const desc = await resolveDescriptor(cliAlias, args.binary);
  if (!desc) {
    return `Error: CLI '${cliAlias}' is not available. Run action=list to see what's installed.`;
  }

  // v1.5.16: Resolve profile, named skills (registry), and auto-detect.
  const profile = getProfile(desc.alias);
  const skillsRequested = (args.skills as string[] | undefined) ?? undefined;
  const autoDetect = args.skillAutoDetect !== false; // default true
  const sessionCwd = resolveAuthorizedDelegateCwd(cwd, args.cwd ? String(args.cwd) : undefined);

  const skillResolution = profile
    ? resolveSkills({
        requested: skillsRequested,
        profileRegistry: profile.skillsRegistry,
        autoDetect,
        cwd: sessionCwd,
      })
    : resolveSkills({
        requested: skillsRequested,
        autoDetect,
        cwd: sessionCwd,
      });

  // v1.5.40: Resolve and inject active artifact paths (task, plan, walkthrough)
  const injectArtifacts = args.injectArtifacts !== false;
  let artifactContext = "";
  if (injectArtifacts) {
    const artifacts = resolveScopedCliArtifacts(cwd, sessionCwd, args);
    const block = buildArtifactContextBlock(artifacts);
    if (block) {
      artifactContext = block;
    }
  }

  const rawSystemPrompt = args.system ? String(args.system) : undefined;
  const systemPrompt = artifactContext
    ? (rawSystemPrompt ? `${rawSystemPrompt}\n\n${artifactContext}` : artifactContext)
    : rawSystemPrompt;

  // v1.5.16: optional initial prompt (the first message to send after the
  // session is ready).
  const initialPrompt = args.initialMessage
    ? String(args.initialMessage)
    : args.message
    ? String(args.message)
    : undefined;

  const interactive = args.interactive === true;
  const profileArgv = profile
    ? buildSessionArgv(profile, {
        skills: skillResolution.paths,
        interactive,
        extraArgs: (args.args as string[] | undefined) ?? undefined,
      })
    : ((args.args as string[] | undefined) ?? []);

  const envOverrides = (args.env as Record<string, string> | undefined) ?? undefined;
  const sessionEnv = profile
    ? buildSessionEnv(profile, envOverrides)
    : envOverrides
    ? { ...process.env, ...envOverrides }
    : process.env;

  const created = await createSession({
    cliAlias: desc.alias,
    binary: desc.binary,
    cwd: sessionCwd,
    args: profileArgv,
    env: sessionEnv,
    skills: skillResolution.paths,
    conversationId: args.conversationId ? String(args.conversationId) : undefined,
    profileAlias: profile?.alias,
    systemPrompt,
    unresolvedSkills: skillResolution.unresolved,
    // v1.5.17
    maxBufferLines: args.maxBufferLines ? Number(args.maxBufferLines) : undefined,
    idleTimeoutMs:
      args.idleTimeoutMs === undefined ? undefined : Number(args.idleTimeoutMs),
    autoSendInitial:
      args.autoSendInitial === false ? false : args.message || args.initialMessage ? true : undefined,
    initialMessage: args.message
      ? String(args.message)
      : args.initialMessage
      ? String(args.initialMessage)
      : undefined,
  });

  if (!created.ok) {
    return `Error: ${created.error.error} (${created.error.code})`;
  }
  const s = created.session;
  const lines = [
    `Session created: ${s.sessionId}`,
    `  cli:        ${s.cliAlias}`,
    `  binary:     ${s.binary}`,
    `  pid:        ${s.pid ?? "?"}`,
    `  status:     ${s.status}`,
    `  profile:    ${s.profileAlias ?? "(none)"}`,
    `  cwd:        ${s.cwd}`,
    `  skills:     ${JSON.stringify(s.skills ?? [])}`,
    `  system:     ${s.systemPrompt ? JSON.stringify(s.systemPrompt) : "(none)"}`,
    `  log:        ${s.logPath}`,
  ];
  if (s.unresolvedSkills && s.unresolvedSkills.length > 0) {
    lines.push(
      "",
      `⚠ Unresolved skill names: ${s.unresolvedSkills.join(", ")}`,
      `  (Not in the profile's skillsRegistry or ~/.superagent-r/cli-bridge/skills.json.`
    );
  }
  lines.push(
    "",
    "Use action=session.send to send messages, action=session.respond to answer prompts,",
    "action=session.export to dump state, action=session.kill to terminate."
  );
  if (profile) {
    lines.push(
      "",
      `Profile hints:`,
      `  default args:    ${JSON.stringify(profile.defaultArgs)}`,
      `  skills arg:      ${profile.skillsArg ? `--${profile.skillsArg}${profile.skillsRepeatable ? " (repeatable)" : ""}` : "(none)"}`,
      `  resume flag:     ${profile.resumeFlag ? `--${profile.resumeFlag}` : "(none)"}`,
      `  interactive:     ${profile.interactiveFlag ? `-${profile.interactiveFlag.length === 1 ? profile.interactiveFlag : "-" + profile.interactiveFlag}` : "(none)"}`,
      `  prompt template: ${JSON.stringify(profile.defaultPromptTemplate)}`,
      `  auto-detect:     ${profile.autoDetect}`
    );
  }
  if (initialPrompt) {
    const autoFlag = s.autoSendInitial === false ? "NOT " : "";
    lines.push(
      "",
      `Note: initial 'message' (${initialPrompt.length} chars) is recorded. v1.5.17 will ${autoFlag}auto-send it to the CLI as soon as the session becomes ready (using the profile's defaultPromptTemplate).`
    );
  }
  return lines.join("\n");
}

async function handleSessionSend(args: Record<string, unknown>): Promise<string> {
  const sessionId = String(args.sessionId ?? "").trim();
  if (!sessionId) {
    return "Error: 'sessionId' is required for action=session.send.";
  }
  const message = String(args.message ?? "");
  if (!message) {
    return "Error: 'message' is required for action=session.send.";
  }
  const timeoutMs = args.timeoutMs ? Number(args.timeoutMs) : undefined;

  // v1.5.16: If the session has a system prompt and the user didn't opt
  // out, prepend it to the message using the profile's template. The
  // `skipSystem` opt-out is for when the LLM already composed a full
  // message and doesn't want the system re-applied.
  const session = getSession(sessionId);
  let composed = message;
  if (session && session.systemPrompt && args.skipSystem !== true) {
    const profile = session.profileAlias ? getProfile(session.profileAlias) : null;
    const tpl = profile?.defaultPromptTemplate ?? "{system}\n\n{prompt}";
    composed = applyPromptTemplate(tpl, { system: session.systemPrompt, prompt: message });
  }

  const result = await sendToSession({ sessionId, message: composed, timeoutMs });
  if ("error" in result) {
    return `Error: ${result.error} (${result.code})`;
  }
  return formatSendResult(sessionId, result);
}

/**
 * v1.5.15: Answer a pending interactive prompt. We delegate to sendToSession
 * since the semantics are identical (write to stdin, wait for stable state).
 */
async function handleSessionRespond(args: Record<string, unknown>): Promise<string> {
  const sessionId = String(args.sessionId ?? "").trim();
  if (!sessionId) {
    return "Error: 'sessionId' is required for action=session.respond.";
  }
  const answer = String(args.answer ?? "");
  if (!answer) {
    return "Error: 'answer' is required for action=session.respond.";
  }
  const timeoutMs = args.timeoutMs ? Number(args.timeoutMs) : undefined;

  const result = await respondToSession({ sessionId, answer, timeoutMs });
  if ("error" in result) {
    return `Error: ${result.error} (${result.code})`;
  }
  return formatSendResult(sessionId, result);
}

/**
 * v1.5.15: Resume a session by re-spawning the same CLI with its resume
 * flag and the previous conversationId (if any).
 */
async function handleSessionResume(args: Record<string, unknown>, callerWorkspace: string): Promise<string> {
  const sessionId = String(args.sessionId ?? "").trim();
  const pastSession = sessionId ? getSessionAny(sessionId) : null;
  let cliAlias = String(args.cli ?? "").trim();
  if (!cliAlias && pastSession) {
    cliAlias = pastSession.cliAlias;
  }
  if (!cliAlias) {
    return "Error: 'cli' or 'sessionId' is required for action=session.resume.";
  }
  const desc = await resolveDescriptor(cliAlias, args.binary ?? pastSession?.binary);
  if (!desc) {
    return `Error: CLI '${cliAlias}' is not available. Run action=list to see what's installed.`;
  }
  const profile = getProfile(desc.alias);
  if (!profile) {
    return `Error: No profile found for '${cliAlias}'. Use action=profile.list to see available profiles.`;
  }
  if (!profile.resumeFlag) {
    return `Error: Profile '${cliAlias}' has no resumeFlag defined. This CLI cannot be resumed.`;
  }
  const conversationId = args.conversationId
    ? String(args.conversationId)
    : pastSession?.conversationId;
  const sessionCwd = resolveAuthorizedDelegateCwd(callerWorkspace, args.cwd ? String(args.cwd) : (pastSession?.cwd ?? callerWorkspace));
  const skills = (args.skills as string[] | undefined) ?? pastSession?.skills;
  const systemPrompt = args.system ? String(args.system) : pastSession?.systemPrompt;
  const envOverrides = (args.env as Record<string, string> | undefined) ?? undefined;
  const env = buildSessionEnv(profile, envOverrides);
  const created = await resumeSession({
    cliAlias: desc.alias,
    binary: desc.binary,
    profileAlias: profile.alias,
    cwd: sessionCwd,
    conversationId,
    resume: true,
    skills,
    env,
    args: (args.args as string[] | undefined) ?? undefined,
    systemPrompt,
  });
  if (!created.ok) {
    return `Error: ${created.error.error} (${created.error.code})`;
  }
  const s = created.session;
  return [
    `Session resumed: ${s.sessionId}`,
    `  cli:           ${s.cliAlias}`,
    `  profile:       ${s.profileAlias}`,
    `  resume flag:   --${profile.resumeFlag}`,
    `  conversation:  ${s.conversationId ?? "(none)"}`,
    `  pid:           ${s.pid ?? "?"}`,
    `  status:        ${s.status}`,
    `  log:           ${s.logPath}`,
  ].join("\n");
}

/**
 * v1.5.15: Export a session's current state as a structured block.
 */
function handleSessionExport(args: Record<string, unknown>): string {
  const sessionId = String(args.sessionId ?? "").trim();
  if (!sessionId) {
    return "Error: 'sessionId' is required for action=session.export.";
  }
  const tailLines = args.tailLines ? Number(args.tailLines) : 200;
  const exp = exportSession(sessionId, tailLines);
  if (!exp) {
    return `Error: session not_found: ${sessionId}`;
  }
  return [
    `Exported session ${exp.sessionId}:`,
    `  cli:           ${exp.cliAlias} (binary: ${exp.binary})`,
    `  profile:       ${exp.profileAlias ?? "(none)"}`,
    `  pid:           ${exp.pid ?? "?"}`,
    `  status:        ${exp.status}`,
    `  created:       ${new Date(exp.createdAt).toISOString()}`,
    `  last activity: ${new Date(exp.lastActivityAt).toISOString()}`,
    `  conversation:  ${exp.conversationId ?? "(none)"}`,
    `  skills:        ${JSON.stringify(exp.skills ?? [])}`,
    `  cwd:           ${exp.cwd}`,
    `  log:           ${exp.logPath}`,
    `  pending:       ${exp.pendingPrompt ? `[${exp.pendingPrompt.kind}] ${exp.pendingPrompt.question}` : "(none)"}`,
    "",
    "JSON:",
    JSON.stringify(exp, null, 2),
  ].join("\n");
}

/**
 * v1.5.15: Show the profile config used by a given session.
 */
function handleSessionConfig(sessionId: string): string {
  if (!sessionId) {
    return "Error: 'sessionId' is required for action=session.config.";
  }
  const s = getSession(sessionId);
  if (!s) {
    return `Error: session not_found: ${sessionId}`;
  }
  const profile = s.profileAlias ? getProfile(s.profileAlias) : null;
  if (!profile) {
    return `Session ${sessionId} has no profile (was created with custom binary).`;
  }
  return [
    `Profile for session ${sessionId}:`,
    `  alias:           ${profile.alias}`,
    `  default args:    ${JSON.stringify(profile.defaultArgs)}`,
    `  resume flag:     ${profile.resumeFlag ? `--${profile.resumeFlag}` : "(none)"}`,
    `  resume style:    ${profile.resumeArgStyle}`,
    `  skills arg:      ${profile.skillsArg ? `--${profile.skillsArg}` : "(none)"}`,
    `  skills repeated: ${profile.skillsRepeatable}`,
    `  skills registry: ${Object.keys(profile.skillsRegistry).length} named skill(s) [${Object.keys(profile.skillsRegistry).join(", ") || "(none)"}]`,
    `  auto-detect:     ${profile.autoDetect}`,
    `  prompt as arg:   ${profile.promptAsArg}`,
    `  prompt subcmd:   ${JSON.stringify(profile.promptSubcommand)}`,
    `  prompt template: ${JSON.stringify(profile.defaultPromptTemplate)}`,
    `  interactive:     ${profile.interactiveFlag ? `-${profile.interactiveFlag.length === 1 ? profile.interactiveFlag : "-" + profile.interactiveFlag}` : "(none)"}`,
    `  env passthrough: ${JSON.stringify(profile.envPassthrough)}`,
    `  env allow-list:  ${profile.envAllowList ? JSON.stringify(profile.envAllowList) : "(forward all)"}`,
    `  schema version:  ${profile.schemaVersion}`,
  ].join("\n");
}

// ─── v1.5.17 handlers ────────────────────────────────────────────────

/**
 * action=session.tail — return buffered events for a session.
 *
 * Params:
 *   - sessionId: target session
 *   - since: only return events with seq > since (default 0 = all)
 *   - tailLimit: cap on events returned (default 200)
 *   - setIdleTimeoutMs: if supplied, update the session's idle TTL
 *     BEFORE returning the tail (convenient — the LLM can extend the
 *     session and get a snapshot in one call)
 */
function handleSessionTail(args: Record<string, unknown>): string {
  const sessionId = String(args.sessionId ?? "").trim();
  if (!sessionId) {
    return "Error: 'sessionId' is required for action=session.tail.";
  }
  // Optional: set the idle timeout in the same call.
  if (args.setIdleTimeoutMs !== undefined) {
    const ms = Number(args.setIdleTimeoutMs);
    if (!Number.isFinite(ms) || ms < 0) {
      return `Error: setIdleTimeoutMs must be a non-negative number, got: ${args.setIdleTimeoutMs}`;
    }
    const ok = setIdleTimeout(sessionId, ms);
    if (!ok) {
      return `Error: cannot setIdleTimeout for ${sessionId}: session not found.`;
    }
  }
  const s = getSessionAny(sessionId);
  if (!s) return `Error: session '${sessionId}' not found.`;

  const since = args.since === undefined ? 0 : Number(args.since);
  const limit = args.tailLimit === undefined ? 200 : Number(args.tailLimit);
  const events = tailEvents(sessionId, Number.isFinite(since) ? since : 0, Number.isFinite(limit) ? limit : 200);
  const lastSeq = getLastEventSeq(sessionId);
  const lines: string[] = [];
  lines.push(`Session ${sessionId} (${s.status}, stage=${s.currentStage ?? s.status}, detached=${s.detached})`);
  lines.push(`  idle:           ${s.idleTimeoutMs === 0 ? "disabled" : `${Math.round(s.idleTimeoutMs / 1000)}s TTL`}${s.autoKilled ? " [auto-killed]" : ""}`);
  lines.push(`  lastActive:     ${formatAge(Date.now() - s.lastOutputAt)} ago`);
  lines.push(`  buffer cap:     ${s.maxBufferLines} lines`);
  lines.push(`  lastEventSeq:   ${lastSeq}`);
  lines.push(`  events returned: ${events.length} (since=${since}, limit=${limit})`);
  if (events.length > 0) {
    lines.push("");
    for (const ev of events) {
      const timeStr = new Date(ev.at).toISOString().slice(11, 23);
      let payload = "";
      if (ev.type === "stdout" || ev.type === "stderr") payload = ev.data.line ?? "";
      else if (ev.type === "prompt") payload = `[${ev.data.prompt?.kind}] ${ev.data.prompt?.question}`;
      else if (ev.type === "status") payload = `status=${ev.data.status}`;
      else if (ev.type === "exit") payload = `code=${ev.data.code} signal=${ev.data.signal}`;
      lines.push(`  [${timeStr}] #${ev.seq} [${ev.type.padEnd(6)}] ${payload}`);
    }
  }
  return lines.join("\n");
}

/**
 * action=session.detach — release the session from the manager without
 * killing the process. The child keeps running and can still be killed
 * later via session.kill.
 */
function handleSessionDetach(sessionId: string): string {
  if (!sessionId) {
    return "Error: 'sessionId' is required for action=session.detach.";
  }
  const s = getSession(sessionId);
  if (!s) {
    return `Error: session not found: ${sessionId}. Use session.list to see active sessions.`;
  }
  if (s.status === "exited" || s.status === "errored") {
    return `Error: session ${sessionId} is already ${s.status} — nothing to detach.`;
  }
  const ok = detachSession(sessionId);
  if (!ok) return `Error: failed to detach ${sessionId}.`;
  return [
    `Detached session ${sessionId}.`,
    `  cli:           ${s.cliAlias}`,
    `  pid:           ${s.pid ?? "?"}`,
    `  status:        ${s.status}`,
    ``,
    `The process is still running in the background. Use session.kill sessionId=${sessionId} to terminate it.`,
    `Detached sessions are NOT auto-killed by the idle TTL.`,
  ].join("\n");
}

/**
 * v1.5.15: List all loaded CLI profiles.
 */
function handleProfileList(): string {
  const profiles = loadProfiles();
  const global = loadGlobalSkillRegistry();
  const lines: string[] = [];
  lines.push(`Loaded ${Object.keys(profiles).length} CLI profile(s):`);
  lines.push("");
  for (const p of Object.values(profiles)) {
    lines.push(`  • ${p.alias}`);
    lines.push(`      default args:    ${JSON.stringify(p.defaultArgs)}`);
    lines.push(`      resume flag:     ${p.resumeFlag ? `--${p.resumeFlag}` : "(none)"}`);
    lines.push(`      skills:          ${p.skillsArg ? `--${p.skillsArg}${p.skillsRepeatable ? " (repeatable)" : ""}` : "(none)"}`);
    lines.push(`      named skills:    ${Object.keys(p.skillsRegistry).length} (${Object.keys(p.skillsRegistry).join(", ") || "(none)"})`);
    lines.push(`      auto-detect:     ${p.autoDetect}`);
    lines.push(`      prompt template: ${JSON.stringify(p.defaultPromptTemplate)}`);
    lines.push(`      interactive:     ${p.interactiveFlag ? `-${p.interactiveFlag.length === 1 ? p.interactiveFlag : "-" + p.interactiveFlag}` : "(none)"}`);
    lines.push(`      env passthrough: ${JSON.stringify(p.envPassthrough)}`);
  }
  lines.push("");
  lines.push(`Global skill registry: ${Object.keys(global).length} named skill(s) (${Object.keys(global).join(", ") || "(none)"})`);
  lines.push(`Profile override file: ${getRootConfigDir()}/${PROFILE_FILE_NAME}`);
  lines.push(`Global skills file:    ${getRootConfigDir()}/${SKILL_REGISTRY_FILE_NAME}`);
  lines.push("");
  lines.push("Tip: drop a partial profile to override any field (deep-merged on top of defaults).");
  lines.push("Tip: register a named skill in skills.json to refer to it by name in any session.");
  return lines.join("\n");
}

function formatSendResult(sessionId: string, result: SendResult): string {
  const lines: string[] = [];
  lines.push(
    `Session ${sessionId} responded (${result.durationMs}ms${result.timedOut ? ", TIMED OUT (returning partial)" : ""}, status=${result.status})`
  );
  lines.push("");
  lines.push("Response:");
  lines.push(result.response || "(empty)");
  if (result.pendingPrompt) {
    lines.push("");
    lines.push("─".repeat(60));
    lines.push(`⚠ Session is now blocked on an interactive prompt.`);
    lines.push(`  kind:     ${result.pendingPrompt.kind}`);
    lines.push(`  question: ${result.pendingPrompt.question}`);
    if (result.pendingPrompt.options && result.pendingPrompt.options.length > 0) {
      lines.push(`  options:  ${result.pendingPrompt.options.join(" | ")}`);
    }
    lines.push("");
    lines.push(`To answer, call: action=session.respond sessionId=${sessionId} answer="<your answer>"`);
    lines.push(`To inspect:    action=session.get sessionId=${sessionId}`);
  }
  return lines.join("\n");
}

function handleSessionList(callerWorkspace: string): string {
  const list = listSessions().filter(session => cliSessionVisibleToWorkspace(session, callerWorkspace));
  const detached = listDetachedSessions().filter(id => {
    const session = getSessionAny(id);
    return Boolean(session && cliSessionVisibleToWorkspace(session, callerWorkspace));
  });
  if (list.length === 0 && detached.length === 0) {
    return "No active sessions. Use action=session.create to start one.";
  }
  const lines: string[] = [`Active sessions: ${list.length} (detached: ${detached.length})`, ""];
  for (const s of list) {
    const age = formatAge(Date.now() - s.createdAt);
    const lastActive = formatAge(Date.now() - s.lastOutputAt);
    const stage = s.currentStage ? ` stage=${s.currentStage.slice(0, 40)}` : "";
    lines.push(
      `  • ${s.sessionId}  cli=${s.cliAlias}  pid=${s.pid ?? "?"}  status=${s.status}${stage}  age=${age}  lastActive=${lastActive} ago  lines=${s.totalLinesEmitted ?? 0}`
    );
  }
  for (const id of detached) {
    const ds = detachedSessionsFull(id);
    lines.push(
      `  · ${id}  cli=${ds?.cliAlias ?? "?"}  pid=${ds?.pid ?? "?"}  status=${ds?.status ?? "?"}  (detached — process still alive, not auto-killed)`
    );
  }
  lines.push("");
  lines.push("JSON:");
  // Include both active and detached in JSON.
  const all = list.concat(detached.map((id) => detachedSessionsFull(id)).filter(Boolean) as any);
  lines.push(JSON.stringify(all, null, 2));
  return lines.join("\n");
}

function handleSessionGet(sessionId: string): string {
  if (!sessionId) {
    return "Error: 'sessionId' is required for action=session.get.";
  }
  const s = getSessionAny(sessionId);
  if (!s) return `Error: Session '${sessionId}' not found.`;
  const elapsedMs = Date.now() - s.createdAt;
  const idleMs = Date.now() - s.lastOutputAt;
  const lines = [
    `Session ${s.sessionId}`,
    `  cli:           ${s.cliAlias}`,
    `  binary:        ${s.binary}`,
    `  pid:           ${s.pid ?? "(not running)"}`,
    `  status:        ${s.status}`,
    `  stage:         ${s.currentStage ?? (s.status === "ready" ? "Ready" : s.status)}`,
    `  exitCode:      ${s.exitCode !== null ? s.exitCode : "(running)"}`,
    `  duration:      ${formatAge(elapsedMs)} (started ${new Date(s.createdAt).toISOString()})`,
    `  lastActive:    ${formatAge(idleMs)} ago (${new Date(s.lastOutputAt).toISOString()})`,
    `  linesEmitted:  ${s.totalLinesEmitted ?? s.stdoutBuffer.split("\n").length}`,
    `  lastOutput:    ${s.lastOutputLine ? JSON.stringify(s.lastOutputLine) : "(none)"}`,
    `  profile:       ${s.profileAlias ?? "(none)"}`,
    `  conversation:  ${s.conversationId ?? "(none)"}`,
    `  skills:        ${JSON.stringify(s.skills ?? [])}`,
    `  system:        ${s.systemPrompt ? JSON.stringify(s.systemPrompt) : "(none)"}`,
    `  detached:      ${s.detached}`,
    `  maxBuffer:     ${s.maxBufferLines} lines`,
    `  idleTimeout:   ${s.idleTimeoutMs === 0 ? "disabled" : `${Math.round(s.idleTimeoutMs / 1000)}s`}${s.autoKilled ? " [auto-killed]" : ""}`,
    `  cwd:           ${s.cwd}`,
    `  log:           ${s.logPath}`,
  ];
  if (s.unresolvedSkills && s.unresolvedSkills.length > 0) {
    lines.push(`  unresolved:    ${JSON.stringify(s.unresolvedSkills)}`);
  }
  if (s.pendingPrompt) {
    lines.push(
      "",
      `Pending interactive prompt:`,
      `  kind:     ${s.pendingPrompt.kind}`,
      `  question: ${s.pendingPrompt.question}`,
      ...(s.pendingPrompt.options && s.pendingPrompt.options.length > 0
        ? [`  options:  ${s.pendingPrompt.options.join(" | ")}`]
        : []),
      "",
      `Use action=session.respond sessionId=${s.sessionId} answer="<value>" to answer.`
    );
  }
  const stdoutLines = s.stdoutBuffer ? s.stdoutBuffer.split("\n") : [];
  const stderrLines = s.stderrBuffer ? s.stderrBuffer.split("\n") : [];
  lines.push(
    "",
    `Stdout buffer (last ${stdoutLines.length} lines):`,
    s.stdoutBuffer || "(empty)",
    "",
    `Stderr buffer (last ${stderrLines.length} lines):`,
    s.stderrBuffer || "(empty)"
  );
  return lines.join("\n");
}

function handleSessionKill(sessionId: string): string {
  if (!sessionId) {
    return "Error: 'sessionId' is required for action=session.kill.";
  }
  const r = killSession(sessionId);
  if (!r.ok) {
    return `Error: ${r.reason ?? "failed"}`;
  }
  return `Session ${sessionId} killed.`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function resolveDescriptor(
  cliAlias: string,
  customBinary?: unknown
): Promise<CliDescriptor | null> {
  const normalized = cliAlias.toLowerCase().trim();
  if (normalized === "custom") {
    const bin = typeof customBinary === "string" ? customBinary.trim() : "";
    if (!bin) {
      return null;
    }
    return {
      alias: "custom",
      binary: bin,
      label: "Custom CLI",
      available: true,
    };
  }
  const known = knownCliDescriptors();
  const base = known.find((d) => d.alias === normalized);
  if (!base) {
    return null;
  }
  // Re-run detection just for this alias so `available` is fresh.
  const detected = (await detectAvailableClis()).find((d) => d.alias === normalized);
  if (!detected || !detected.available) {
    return null;
  }
  return detected;
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}
