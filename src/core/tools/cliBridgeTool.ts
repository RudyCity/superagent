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
 *   • **1-shot** (action=delegate) — fire-and-forget: spawn the CLI with the
 *     prompt, wait for it to exit, return the captured output. Ideal for
 *     "ask Codex to write a Python script" style calls.
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
import { createRequire } from "node:module";

// ─── Tool definition ─────────────────────────────────────────────────────

const ACTIONS = [
  "list",
  "delegate",
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
    "Two modes: (1) `delegate` for one-shot prompts, (2) `session.*` for multi-turn interactive sessions. " +
    "Use `list` to discover installed CLIs, `delegate` for simple asks, and `session.create`+`session.send`+`session.kill` for ongoing collaboration with a separate AI. " +
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
          "'delegate' for 1-shot prompt, " +
          "'session.create' to start an interactive session (optionally with initial `message` to auto-send once ready), " +
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
          "v1.5.17: for action=session.tail, cap the number of events returned (default 200).",
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
        description: "Trailing stdout/stderr lines to include in session.export (default 200).",
      },
      timeoutMs: {
        type: "number",
        description:
          "Timeout in milliseconds. Defaults: 300_000 for delegate, 120_000 for session.send.",
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
      switch (action) {
        case "list":
          return await handleList();

        case "delegate":
          return await handleDelegate(args, cwd, signal);

        case "session.create":
          return await handleSessionCreate(args, cwd);

        case "session.send":
          return await handleSessionSend(args);

        case "session.list":
          return handleSessionList();

        case "session.get":
          return handleSessionGet(String(args.sessionId ?? ""));

        case "session.kill":
          return handleSessionKill(String(args.sessionId ?? ""));

        case "session.resume":
          return await handleSessionResume(args);

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
  const timeoutMs = args.timeoutMs ? Number(args.timeoutMs) : undefined;

  // v1.5.16: Apply the profile's prompt template with system (if any).
  const profile = getProfile(desc.alias);
  const systemPrompt = args.system ? String(args.system) : undefined;
  const tpl = profile?.defaultPromptTemplate ?? "{system}\n\n{prompt}";
  const composedPrompt = applyPromptTemplate(tpl, { system: systemPrompt ?? "", prompt });

  // Resolve default args and prompt subcommands for 1-shot execution:
  const defaultFlags = profile?.defaultArgs ?? desc.defaultArgs ?? [];
  const promptSub = profile?.promptSubcommand ?? desc.promptSubcommand ?? [];
  const autoFlags = desc.alias === "agy" && !extraArgs.includes("--dangerously-skip-permissions")
    ? ["--dangerously-skip-permissions"]
    : [];
  const combinedArgs = Array.from(new Set([...defaultFlags, ...autoFlags, ...extraArgs, ...promptSub]));

  const result: DelegateResult = await runDelegate({
    cliAlias: desc.alias,
    binary: desc.binary,
    prompt: composedPrompt,
    cwd,
    extraArgs: combinedArgs,
    timeoutMs,
    signal,
  });

  return formatDelegateResult(result, composedPrompt, combinedArgs);
}

function formatDelegateResult(
  result: DelegateResult,
  prompt: string,
  extraArgs: string[]
): string {
  const lines: string[] = [];
  lines.push(`Delegated to ${result.cliAlias} (exit=${result.exitCode ?? "?"}, ${result.durationMs}ms${result.timedOut ? ", TIMED OUT" : ""})`);
  if (extraArgs.length > 0) {
    lines.push(`Extra args: ${JSON.stringify(extraArgs)}`);
  }
  lines.push(`Prompt (${prompt.length} chars): ${prompt.slice(0, 200)}${prompt.length > 200 ? "…" : ""}`);
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
  const sessionCwd = args.cwd ? String(args.cwd) : cwd;

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

  const systemPrompt = args.system ? String(args.system) : undefined;

  // v1.5.16: optional initial prompt (the first message to send after the
  // session is ready). Currently we just record it; future work could
  // pipe it through sendToSession once status flips to "ready".
  const initialPrompt = args.message ? String(args.message) : undefined;

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
async function handleSessionResume(args: Record<string, unknown>): Promise<string> {
  const cliAlias = String(args.cli ?? "").trim();
  if (!cliAlias) {
    return "Error: 'cli' is required for action=session.resume.";
  }
  const desc = await resolveDescriptor(cliAlias, args.binary);
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
  const conversationId = args.conversationId ? String(args.conversationId) : undefined;
  const sessionCwd = args.cwd ? String(args.cwd) : process.cwd();
  const envOverrides = (args.env as Record<string, string> | undefined) ?? undefined;
  const env = buildSessionEnv(profile, envOverrides);
  const created = await resumeSession({
    cliAlias: desc.alias,
    binary: desc.binary,
    profileAlias: profile.alias,
    cwd: sessionCwd,
    conversationId,
    resume: true,
    skills: (args.skills as string[] | undefined) ?? undefined,
    env,
    args: (args.args as string[] | undefined) ?? undefined,
    systemPrompt: args.system ? String(args.system) : undefined,
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

function getRootConfigDir(): string {
  // Synchronous require is OK here — this is only called when listing profiles,
  // and the path module has no side effects. Wrapped to keep ESM smoke tests
  // working (dist/ emits CJS so this works in tests; ESM callers will
  // import via createRequire).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const req = (typeof require === "function" ? require : createRequire(import.meta.url));
  return req("../config/paths.js").getRootConfigDir();
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

function handleSessionList(): string {
  const list = listSessions();
  const detached = listDetachedSessions();
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
