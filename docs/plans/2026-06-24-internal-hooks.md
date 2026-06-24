# Add /internal-hooks (/ih) Command and Dynamic Custom Tools Loading

This plan adds a dynamic hooks loading system to Superagent under `internal-hooks/` at the root, which registers custom user tools at runtime. It also provides the `/internal-hooks` (or `/ih`) slash command with `init` and `dev` subcommands.

## User Review Required

> [!NOTE]
> **Hook Workspace Scope:**
> Each hook is initialized as its own subdirectory project (e.g. `internal-hooks/<namahook>`) containing its own `package.json` and boilerplate scripts.
>
> Running `/ih dev <namahook>` will execute the development process directly inside the hook's folder (`cwd: internal-hooks/<namahook>`), allowing it to build, test, and run locally in its own workspace.

> [!IMPORTANT]
> **Agent Skill Integration:**
> A new agent skill `.agents/skills/internal-hooks/SKILL.md` will be created to document how developers and future agent instances should build, structure, configure, and verify custom internal hooks.

## Open Questions

None at this time.

## Proposed Changes

### Dynamic Tool Loader

#### [NEW] [dynamicHooks.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/tools/dynamicHooks.ts)
Implement `loadDynamicHooks()` to:
- Read subdirectories inside `internal-hooks/` dynamically on startup.
- Load `hook.json` containing `name`, `description`, `parameters`, and optionally `command`.
- Wrap hook scripts in a `Tool` class executing via `execa`.
- Inject environment variables (`SUPERAGENT_HOOK_DIR`, `SUPERAGENT_CWD`, `SUPERAGENT_WORKSPACE`, `SUPERAGENT_HOOK_INPUT`) and pipe input arguments via `stdin`.

#### [MODIFY] [index.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/tools/index.ts)
- Load dynamic tools from `dynamicHooks.ts` and register them dynamically.

---

### Command Registry & Auto-completion

#### [NEW] [internalHooksCommand.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/commands/internalHooksCommand.ts)
Implement the `/internal-hooks` (`/ih`) command:
- `init <namahook>`: Creates `internal-hooks/<namahook>/` and generates:
  - `hook.json` (metadata & params schema)
  - `package.json` (sub-project configuration with a `dev` script: `"dev": "node index.js"`)
  - `index.js` (main entrypoint parsing stdin args)
  - `test-payload.json` (mock arguments for local testing)
- `dev <namahook>`: 
  - Resolves `internal-hooks/<namahook>` directory.
  - If a `package.json` contains a `dev` script, run it. Otherwise run the command from `hook.json` or fallback to `node index.js`.
  - Runs the command interactively inside the hook project directory (`cwd: internal-hooks/<namahook>`) using `ctx.runInteractiveProcess` if available, or falls back to execution via `execa`.

#### [MODIFY] [index.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/commands/index.ts)
- Register `internalHooksCommand` in the slash commands index registry.

#### [MODIFY] [dashboardSuggestions.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/utils/dashboardSuggestions.ts)
- Provide autocomplete suggestions for `/ih init` and `/ih dev`.
- Read `internal-hooks/` folder to suggest existing hook names.

#### [MODIFY] [app.tsx](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/app.tsx)
- Integrate suggestion filtering for `/ih` and `/internal-hooks` subcommands and arguments.

---

### Documentation & Skills

#### [NEW] [SKILL.md](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/.agents/skills/internal-hooks/SKILL.md)
- Dynamic custom hook development reference guide for AI agents and developers.

---

## Verification Plan

### Automated Tests
- Create `tests/internalHooks.test.ts` to test:
  - dynamic tool loading.
  - `/ih init` files scaffolding inside `internal-hooks/`.
  - `/ih dev` script execution inside the hook workspace folder.
- Run tests: `npm test tests/internalHooks.test.ts`

### Manual Verification
1. Start CLI: `npm run dev`
2. Run `/ih init test-trade`
3. Run `/ih dev test-trade` and verify it runs in `internal-hooks/test-trade/`.
4. Verify dynamic tools autocomplete in GUI.
