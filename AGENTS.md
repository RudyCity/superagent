# Project Specifications (agents.md)

This file contains key information about the project for AI agents to study and align with when working on Superagent.

## Project Overview
- **Name**: Superagent
- **Description**: An interactive, terminal-based AI coding assistant featuring a cyberpunk style terminal UI, context token tracking, and a 3-tier multi-agent orchestration system (Master Agent → Superagent → Subagent).
- **Technology Stack**: Node.js, TypeScript, React, Ink (Terminal UI Components), Vercel AI SDK, Execa, Vitest

## 3-Tier Multi-Agent Architecture

Superagent supports a full 3-tier agent hierarchy activated via `superagent --multi`:

```
Master Agent  (orchestrator)
  └── Superagent  (per-feature, isolated in git worktree)
        └── Subagent  (atomic ops, ephemeral)
```

### Tier Responsibilities
| Tier | Role | Toolset | Isolation |
|------|------|---------|-----------|
| **Master Agent** | Orchestration, planning, result merging | `invokeSuperagentTool`, `awaitSuperagentsTool`, `mergeSuperagentsTool`, `manageSuperagentsTool`, `manageSubagentsTool`, `gitWorktreeTool` | Main repo |
| **Superagent** | Feature-level development | Shell + File tools + `invokeSubagentTool`, `manageSubagentsTool`, `gitWorktreeTool` | Isolated git worktree (`~/.superagent-r/worktrees/<name>`) |
| **Subagent** | Atomic file/search operations | File tools only (read/write/search/grep) | Ephemeral, within parent worktree |

### Key Files
- `src/core/masterAgent.ts` — Master Agent entry point and orchestrator logic
- `src/core/tools/types.ts` — Shared types: `AgentTier`, `SubagentInstance`, `ToolSet`
- `src/core/tools/toolsets.ts` — ToolSet definitions keyed per tier (`masterToolset`, `superagentToolsets`, `subagentToolsets`)
- `src/core/tools/prompts.ts` — System prompts per tier with dynamic context injection
- `src/core/tools/state.ts` — Shared subagent registry, instances map, event emitters
- `src/core/tools/superagentTools.ts` — Master tier tools: invoke/list/merge/manage Superagents
- `src/core/tools/subagentTools.ts` — Superagent tier tools: spawn ephemeral Subagents
- `src/core/context/ContextManager.ts` — Central orchestrator for context window management (state machine, strategy selection, recovery)
- `src/core/context/TokenTracker.ts` — Model-specific token counting via tiktoken (includes tool calls/results)
- `src/core/context/CompactionStrategy.ts` — Pluggable strategy interface for compaction algorithms
- `src/core/context/strategies/SummarizationStrategy.ts` — LLM-based summarization (with heuristic fallback)
- `src/core/context/strategies/PruningStrategy.ts` — Emergency pruning with summary preservation (never silent context loss)
- `src/core/context/strategies/PinningStrategy.ts` — Preserve critical pinned messages during compaction
- `src/core/context/SemanticAnalyzer.ts` — Topic boundary detection, importance scoring, key point extraction
- `src/core/context/CompactionHistory.ts` — Audit trail with disk persistence for all compaction events

## Coding Guidelines & Constraints
- **Language — English Only**: All user-facing text strings, UI labels, log messages, comments, variable names, documentation, and any other text content MUST be written in English. No exceptions.
- **Shell Commands**: On Windows, the actual shell is auto-detected (Git Bash is preferred over PowerShell). If using PowerShell, use `;` to separate commands instead of `&&`. Git Bash supports `&&` normally. The system prompt reports the detected shell accurately.
- **Strict Naming Rules**: Do NOT mention proprietary brand names like "Claude Code" or generic "CLI" terms in user-facing documentation or UI descriptions. Refer to the project as a terminal-based AI coding assistant.
- **Workspace Isolation**: Configuration (`model-config.json`), logs (`superagent.log`), and session histories MUST be stored in the global home directory under `~/.superagent-r/` instead of cluttering the target project repository. Superagent worktrees are stored under `~/.superagent-r/worktrees/<name>`.
- **Model Config & Credentials — JSON ONLY, NO process.env**: All provider credentials, model configurations, active presets, tier models, profiles, and system settings are stored exclusively in `~/.superagent-r/model-config.json`. There is **NO** use of `process.env` for model, provider, or settings data anywhere in production code. This is a hard rule with NO exceptions:
  - **Reading models**: Use helper functions from `src/core/config/providers.ts`:
    - `getEffectiveMasterModel(mode)` — returns the primary model name for the given mode (`"multi"`, `"single"`, or `"auto"`)
    - `getTierModel(mode, tier)` — returns a specific tier's model (`tier`: `"master"`, `"superagent"`, `"subagent"`, `"researcher"`, `"coder"`, `"reviewer"`, or any custom subagent name)
    - `getAllTierModels(mode)` — returns a `Record<string, string>` of all tier models including subagent details
  - **Writing models**: Use helper functions from `src/core/config/providers.ts`:
    - `setTierModel(mode, tier, modelName, providerProfileId?)` — writes a specific tier's model to JSON and persists
    - `setAllTierModels(mode, modelName, providerProfileId?)` — writes ALL tiers at once to JSON and persists
    - `clearTierModel(mode, tier)` — clears a tier's model override
  - **Provider info**: Use `getActiveProviderName()` and `getConfiguredProviders()` — both read from JSON, never from env vars.
  - **System settings** (concurrency, rate limit, streaming, context window, max iterations): Use `getSettings()` to read and `updateSettings()` to write — both from `src/core/config/jsonConfig.ts`. These functions read/write directly to `model-config.json`. **NEVER use `process.env` to read or write settings.**
  - `/login` (add provider wizard): use `addProvider()` to save to JSON, then `switchActiveProvider()` to activate.
  - `/model` (model/preset wizard): use `savePreset()`, `applyModelPreset()`, `setTierModel()`, `setAllTierModels()` — all JSON.
  - `/settings` (settings commands): use `getSettings()` to display and `updateSettings()` to persist — all JSON.
  - **NEVER read or write `process.env.MODEL`, `process.env.MODEL_*`, `process.env.ACTIVE_PROVIDER`, `process.env.ANTHROPIC_API_KEY`, `process.env.CUSTOM_BASE_URL`, `process.env.OPENAI_API_KEY`, `process.env.SUPERAGENT_MAX_CONCURRENCY`, `process.env.SUPERAGENT_RATE_LIMIT_*`, `process.env.DISABLE_STREAMING`, `process.env.CONTEXT_WINDOW_LIMIT`, or `process.env.MAX_ITERATIONS`** — all of these have been fully migrated to JSON config helpers (`getSettings()`, `getTierModel()`, `getConfiguredProviders()`, etc.).
  - **`updateEnvFile()` has been removed** — it no longer exists. The file `src/core/config/env.ts` has been deleted. All config flows through `jsonConfig.ts` functions.
- **Interactive Prompts**: Ensure any executed shell command processes are monitored for interactive inputs (such as asking for yes/no confirmation) to alert the user rather than hanging in the background.
- **Test Location**: Always create and place all test files inside the `tests/` directory at the project root. Do not place test files under the `src/` directory.
- **Circular Dependency Prevention**: `toolsets.ts` and `prompts.ts` are imported by multiple tool files. Any tool file that needs to import from `toolsets.ts` or `prompts.ts` MUST use dynamic `import()` inside the `execute()` function body — never a top-level static import — to avoid circular module dependency errors.
- **Tier Enforcement**: Do NOT add orchestration tools (e.g., `invokeSubagentTool`) to Superagent or Subagent toolsets. Each tier must only have the tools listed in `toolsets.ts` for that tier.
- **Master Agent Planning**: The Master Agent is restricted from directly modifying codebase files and MUST delegate all feature implementation to Superagents. Therefore, the Master Agent's Implementation Plan and Task Tracking files MUST explicitly focus on spawning, monitoring, and merging Superagents (specifying their roles, git branches, and feature tasks) rather than detailing direct file edits as if it were performing them itself.
- **Commit Final Changes**: Every final change or completed task/feature must be staged and committed to the git repository.
- **Code Limits & Architecture**: Keep all code files under 1200 lines to ensure readability. Always design with a single source of truth, focus on modularity, maintainability, scalability, and adhere to industry best practices.
- **Exploration & Research**: When performing codebase exploration, investigation, or research, always spawn a subagent to handle the task.
- **Mandatory Skill Reading**: At the very start of the workflow to solve any user request, you MUST identify all relevant skills and read their `SKILL.md` instructions using the `view_file` tool before making plans or taking action.





## Verification Checklist
- Run `npm test` to verify that all unit tests pass before committing.
- Build the project using `npm run build` to verify there are no TypeScript compilation errors.
- After adding new tools, verify they are added to the correct tier toolset in `toolsets.ts` and not to other tiers.
- After modifying `subagentTools.ts` or `superagentTools.ts`, check for circular dependency issues — imports of `toolsets.ts`/`prompts.ts` must be dynamic.
