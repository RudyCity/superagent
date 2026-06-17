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

## Coding Guidelines & Constraints
- **Shell Commands**: On Windows, the actual shell is auto-detected (Git Bash is preferred over PowerShell). If using PowerShell, use `;` to separate commands instead of `&&`. Git Bash supports `&&` normally. The system prompt reports the detected shell accurately.
- **Strict Naming Rules**: Do NOT mention proprietary brand names like "Claude Code" or generic "CLI" terms in user-facing documentation or UI descriptions. Refer to the project as a terminal-based AI coding assistant.
- **Workspace Isolation**: Configuration `.env`, logs (`superagent.log`), and session histories MUST be stored in the global home directory under `~/.superagent-r/` instead of cluttering the target project repository. Superagent worktrees are stored under `~/.superagent-r/worktrees/<name>`.
- **Model Config & Credentials**: All model configurations, active presets, profiles, and provider API credentials must be resolved and managed directly from the JSON files (`model-config.json` and `model-presets.json` inside `~/.superagent-r/`). Do NOT write or read legacy environment variables such as `MODEL`, `MODEL_SINGLE`, or `ACTIVE_PROVIDER` in `.env` files.
- **Interactive Prompts**: Ensure any executed shell command processes are monitored for interactive inputs (such as asking for yes/no confirmation) to alert the user rather than hanging in the background.
- **Test Location**: Always create and place all test files inside the `tests/` directory at the project root. Do not place test files under the `src/` directory.
- **Circular Dependency Prevention**: `toolsets.ts` and `prompts.ts` are imported by multiple tool files. Any tool file that needs to import from `toolsets.ts` or `prompts.ts` MUST use dynamic `import()` inside the `execute()` function body — never a top-level static import — to avoid circular module dependency errors.
- **Tier Enforcement**: Do NOT add orchestration tools (e.g., `invokeSubagentTool`) to Superagent or Subagent toolsets. Each tier must only have the tools listed in `toolsets.ts` for that tier.
- **Master Agent Planning**: The Master Agent is restricted from directly modifying codebase files and MUST delegate all feature implementation to Superagents. Therefore, the Master Agent's Implementation Plan and Task Tracking files MUST explicitly focus on spawning, monitoring, and merging Superagents (specifying their roles, git branches, and feature tasks) rather than detailing direct file edits as if it were performing them itself.
- **Commit Final Changes**: Every final change or completed task/feature must be staged and committed to the git repository.
- **Code Limits & Architecture**: Keep all code files under 1200 lines to ensure readability. Always design with a single source of truth, focus on modularity, maintainability, scalability, and adhere to industry best practices.
- **Exploration & Research**: When performing codebase exploration, investigation, or research, always spawn a subagent to handle the task.




## Verification Checklist
- Run `npm test` to verify that all unit tests pass before committing.
- Build the project using `npm run build` to verify there are no TypeScript compilation errors.
- After adding new tools, verify they are added to the correct tier toolset in `toolsets.ts` and not to other tiers.
- After modifying `subagentTools.ts` or `superagentTools.ts`, check for circular dependency issues — imports of `toolsets.ts`/`prompts.ts` must be dynamic.
