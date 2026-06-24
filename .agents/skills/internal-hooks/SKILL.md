---
name: Developing Internal Hooks
description: Create, configure, and develop custom automation hooks or tools under internal-hooks/
when_to_use: when creating, debugging, testing, or updating dynamic custom tools or event hooks in Superagent
version: 1.0.0
languages: [typescript, javascript, python, shell]
---

# Developing Internal Hooks

## Overview
Internal Hooks are custom user-defined scripts placed in subdirectories under `internal-hooks/` at the root of the project. They are loaded dynamically at startup and registered as standard tools inside Superagent.

## Hook File Structure
Every hook must be placed in a subdirectory: `internal-hooks/<namahook>/` and contain:

1. **`hook.json`**: Defines the tool schema and parameters.
```json
{
  "name": "my_custom_tool",
  "description": "Describe what the tool does so the AI agent knows when to call it.",
  "parameters": {
    "type": "object",
    "properties": {
      "parameterName": {
        "type": "string",
        "description": "Describe parameter purpose."
      }
    },
    "required": ["parameterName"]
  },
  "command": "node index.js"
}
```

2. **`package.json`**: Configures the hook workspace environment and scripts.
```json
{
  "name": "my-custom-tool-hook",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "node index.js"
  }
}
```

3. **`index.js`** (or target entrypoint): Script executing the logic.
```javascript
import fs from "fs";

// Read args piped from stdin
const input = fs.readFileSync(0, "utf-8");
let args = {};
if (input.trim()) {
  try {
    args = JSON.parse(input);
  } catch (e) {
    console.error("Invalid JSON input:", e.message);
    process.exit(1);
  }
}

// Perform logic using args...
console.log("Hook executed successfully! Args:", JSON.stringify(args));
```

4. **`test-payload.json`**: Arguments payload template for local debugging.
```json
{
  "parameterName": "mock-value"
}
```

## Commands Reference
- **Initialize hook project**: `/ih init <namahook>`
- **Run local development loop**: `/ih dev <namahook>` (Runs `dev` script in `package.json` with `test-payload.json` input)

## Best Practices
- Print clean output to `stdout` representing the result returned to the agent.
- Run error messages through `stderr` and terminate with a non-zero exit code (`process.exit(1)`) to signify failure.
- Avoid interactive prompts since hooks are executed headless by the agent.
- Access the hook directory using `process.env.SUPERAGENT_HOOK_DIR` and the active workspace directory using `process.env.SUPERAGENT_CWD`.
