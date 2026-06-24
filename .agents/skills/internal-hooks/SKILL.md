---
name: Developing Internal Hooks
description: Create, configure, and develop custom automation hooks, slash commands, event hooks, and dynamic skills under internal-hooks/
when_to_use: when creating, debugging, testing, or updating custom tools, slash commands, or event-driven lifecycles in Superagent
version: 1.1.0
languages: [typescript, javascript, python, shell]
---

# Developing Internal Hooks

## Overview
Internal Hooks are custom user-defined scripts placed in subdirectories under `internal-hooks/` at the root of the project. They are loaded dynamically at startup and allow extending Superagent's functionality in four powerful ways:
1. **AI Agent Tools**: Dynamic custom tools available for AI agent execution.
2. **Custom Slash Commands**: Custom command shortcuts available directly in the terminal CLI interface (e.g. `/my-command`).
3. **Event Hooks**: Event-driven hooks executed during critical lifecycle points (e.g. pre-tool, post-tool, pre-command, post-command).
4. **Dynamic Skills**: Custom agent instruction bundles (`skills/<skill_name>/SKILL.md`) packaged directly inside your hook folder.

---

## Hook File Structure
Every hook must be placed in a subdirectory: `internal-hooks/<hook_name>/`. The structure can contain the following:

```
internal-hooks/<hook_name>/
├── hook.json             # Root schema mapping tools, slash commands, and event hooks
├── package.json          # Dependency and script management
├── index.js              # Entrypoint script executing logic
├── test-payload.json     # Stdin mock argument payload for local dev loop testing
└── skills/               # [Optional] Dynamic agent skills directory
    └── <my-custom-skill>/
        └── SKILL.md      # Skill markdown documentation for agent instruction
```

### 1. `hook.json` Configuration
Defines the dynamic tools, custom slash commands, and event hooks.

```json
{
  "name": "my_hook_tool",
  "description": "Expose this custom tool to the AI agent. Describe what it does.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search query."
      }
    },
    "required": ["query"]
  },
  "command": "node index.js --tool",
  
  "slash_commands": [
    {
      "name": "my-cmd",
      "aliases": ["mc"],
      "description": "Trigger my custom command manually in the terminal.",
      "command": "node index.js --cmd"
    }
  ],
  
  "event_hooks": [
    {
      "event": "pre_tool",
      "command": "node index.js --event pre_tool"
    },
    {
      "event": "post_tool",
      "command": "node index.js --event post_tool"
    },
    {
      "event": "pre_command",
      "command": "node index.js --event pre_command"
    },
    {
      "event": "post_command",
      "command": "node index.js --event post_command"
    }
  ]
}
```

### 2. Script Logic (`index.js`)
Scripts can handle inputs depending on whether they are triggered as a tool, command, or event. 
- **AI Agent Tools**: Stdin receives the parameter JSON from the agent.
- **Custom Slash Commands**: Stdin is unused. Arguments typed after the command are appended as command line parameters (e.g. `/my-cmd hello` calls `node index.js --cmd hello`).
- **Event Hooks**: Stdin receives a JSON string containing event metadata.
  - `pre_tool` / `post_tool`: `{ "toolName": string, "args": object, "result"?: any, "cwd": string }`
  - `pre_command` / `post_command`: `{ "command": string, "name": string, "args": string }`

```javascript
import fs from "fs";

// Read piped stdin if present
const stdinContent = fs.readFileSync(0, "utf-8").trim();
let stdinData = {};
if (stdinContent) {
  try {
    stdinData = JSON.parse(stdinContent);
  } catch (e) {
    stdinData = { raw: stdinContent };
  }
}

const args = process.argv.slice(2);
console.log("Hook executed successfully!");
console.log("Arguments passed:", args);
console.log("Stdin JSON read:", JSON.stringify(stdinData));
```

---

## Dynamic Skills
If an active hook contains a `skills/` subdirectory, any skill bundles nested inside it (e.g. `skills/my-skill/SKILL.md`) will automatically be loaded on startup.
- They will appear in `/skills` list.
- They will have tab autocomplete suggestions (`/skill-my-skill` or `/skill my-skill`).
- The AI agent will be able to reference and read them automatically.

---

## Activating Hooks
Hooks are loaded and activated on a per-project basis. There are three ways hooks can be activated:
1. **Auto-Activation upon Initialization**: When you initialize a new hook using `/ih init <hook_name>`, it is automatically added to the active list for the current project.
2. **Interactive Selection via CLI**: Run `/ih active` in the terminal to open an interactive multi-select checkbox list. Checked hooks are activated, and unchecked hooks are deactivated.
3. **Persisted Configuration**: The active status of hooks is stored inside the global settings file `~/.superagent-r/model-config.json` under the `activeHooks` object, keyed by the project's absolute folder path. To activate a hook programmatically, add its directory name to the array mapping for your project path.

---

## Commands Reference
- **Initialize hook project**: `/ih init <hook_name>`
- **Run local development loop**: `/ih dev <hook_name>` (Runs the `dev` script in `package.json` with `test-payload.json` piped as stdin)
- **Toggle active hooks**: `/ih active` (Opens an interactive checklist to toggle which hooks are active)

---

## Best Practices
- **Autocomplete Integration**: Dynamic slash commands registered by hooks are automatically indexed by the terminal's autocomplete suggestion system.
- **Standard Outputs**: Print clean output to `stdout` to return values to the agent or terminal.
- **Errors**: Run error messages to `stderr` and terminate with a non-zero exit code (`process.exit(1)`) to indicate failures.
- **Interactive Guards**: Avoid interactive CLI prompts since agent tools and event hooks run headlessly in the background.
- **Environment Variables**: Access the hook directory using `process.env.SUPERAGENT_HOOK_DIR`, the active workspace directory using `process.env.SUPERAGENT_CWD`, and the lifecycle event type via `process.env.SUPERAGENT_EVENT` (for event hooks).
