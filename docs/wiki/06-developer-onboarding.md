# 06. Developer Onboarding & Contribution Guide

This guide contains everything new developers and contributing AI agents need to know to set up, build, test, and write code for the Superagent codebase.

---

## 1. Prerequisites & Environment Setup

- **Node.js**: v20.x or v22.x LTS
- **Package Manager**: [Bun](https://bun.sh) (preferred) or `npm` / `pnpm`
- **Git**: Git 2.30+ (required for git worktree operations)
- **Shell**: Git Bash or Windows PowerShell

### Quick Setup

```powershell
# Clone repository
git clone https://github.com/RudyCity/superagent.git
cd superagent

# Install dependencies (runs patch-package automatically)
bun install

# Verify build
bun run build

# Run unit tests
bun test
```

---

## 2. Core Development Commands

| Command | Description |
|---|---|
| `bun run dev` | Launch local Superagent CLI using `tsx` on `src/cli.tsx` |
| `bun run build` | Compile TypeScript source code to `dist/` |
| `bun test` | Execute Vitest unit test suite across `tests/` |
| `bun run verify:all` | Run complete validation gate (`build` + extension check + `test`) |
| `bun run wiki:serve` | Launch local Docsify wiki viewer at `http://localhost:3333` |
| `bun run wiki:sync` | Incremental wiki documentation sync on changed codebase files |
| `bun run wiki:validate` | Validate wiki markdown links, anchors, and Mermaid fence structure |

---

## 3. Strict Coding Guidelines & Constraints

### 1. English Only Standard
All user-facing text, UI labels, log entries, code comments, variable and function names, documentation, and prompt strings **MUST** be written in English.

### 2. Zero `process.env` Configuration
Never use `process.env.MODEL`, `process.env.OPENAI_API_KEY`, or `process.env.ACTIVE_PROVIDER`. All configuration flows through JSON helper functions:
- `getEffectiveMasterModel(mode)`
- `getTierModel(mode, tier)`
- `getSettings()` / `updateSettings()`
- `getConfiguredProviders()` / `addProvider()`

### 3. Test Location Rule
All test files **MUST** be placed in the `tests/` root directory (e.g. `tests/contextManager.test.ts`, `tests/tools.test.ts`). **Never** create test files inside the `src/` folder.

### 4. Circular Dependency Prevention
`toolsets.ts` and `prompts.ts` are imported by multiple tools. Any tool file in `src/core/tools/` needing to import from `toolsets.ts` or `prompts.ts` **MUST** use dynamic `import()` inside the `execute()` function body rather than top-level static imports.

### 5. File Size Limit
Keep all source code files strictly under **1000 lines** to maintain readability, modularity, and maintainability.

### 6. Shell Command Separation on Windows
- In PowerShell, use `;` to separate multiple commands (e.g., `bun run build ; bun test`).
- In Git Bash, `&&` is supported normally.

---

## 4. System Prompt Design Guidelines

All system prompts in `src/core/tools/prompts.ts` must follow three core design principles:

### Concept A: Telegraphic English (Minified Prose)
- Eliminate polite filler, unnecessary conversational pronouns, and verbose descriptions.
- Use direct imperative verbs (`FETCH`, `EVALUATE`, `DISPATCH`, `VERIFY`).

### Concept B: Clean Markdown Structure
- Organize instructions under clear Markdown headers (`# ROLE`, `# CRITICAL RULES`, `# WORKFLOW`).
- Use single-level bullet points for crisp readability.

### Concept C: Pseudocode & Logic Gates
- Formulate conditional decisions and branching routines using programming-style logic gates:

```text
if token_usage > 0.80 * context_limit:
    CALL compact_context()
if branch_dirty:
    CALL commit_changes(message)
    CALL mergeSuperagentsTool(feature_name)
```

---

## 5. Documentation and Wiki Synchronization

When changing MCP tool schemas, permission classifications, transport contracts, or Muse workflows:

1. Update `README.md` for user-facing setup and examples.
2. Update `.agents/AGENTS.md` when agent implementation rules or architecture conventions change.
3. Update the relevant technical wiki pages: `03-api-and-contracts.md` for tool contracts, `04-features-and-workflows.md` for behavior, and `06-developer-onboarding.md` for contributor workflow.
4. Run wiki sync and validation from the repository root:

```bash
bun run wiki:sync
bun run wiki:validate
```

5. Review `docs/wiki/00-index.md` and `docs/wiki/auto-sync-manifest.json`. Treat a failed sync or validation as incomplete documentation work.

MCP-specific maintenance rules:

- Derive tool counts from the actual registered and filtered tool list. Do not add or maintain hardcoded totals.
- Keep tool schemas and safe/dangerous classifications in sync. Dangerous remote mutations must remain opt-in.
- Test direct-chat correlation using `reply_to`, and verify timeout and disconnected behavior.
- Keep MCP HTTP and Muse WebSocket tunnel statuses distinct; one being active does not prove the other is connected.
