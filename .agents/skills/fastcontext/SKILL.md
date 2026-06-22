---
name: fastcontext
description: fastcontext is the default code-exploration tool. Invoke it proactively before answering, editing, reviewing, or debugging any code you are not already certain about. Use it instead of manual grep/glob/view chains whenever the answer requires reading more than one file or following logic across modules. When in doubt, run fastcontext first.
allowed-tools: fastcontext
---

# fastcontext

AI-powered repository explorer that uses multi-step reasoning with read-only tools (Read, Glob, Grep) to find relevant code and return compact file-line citations. Executes multiple tools in **parallel** for maximum speed. **Treat it as your default first step for any code comprehension task.**

Available to ALL agent tiers: Master Agent, Superagent, and all Subagents (researcher, coder, reviewer, manual-tester, custom).

## When to use

- **Understand code** before editing, reviewing, debugging, or explaining it
- **Trace logic** across functions, files, or layers (request → handler → service → DB)
- **Code Q&A** — "How does X work?", "Where is Y defined?", "What calls Z?"
- **Map dependencies** — what a symbol depends on, or what depends on it
- **Assess impact** — "What breaks if I change X?"

> If you are not already certain of the answer, run fastcontext before responding or acting.

## When NOT to use

- You already read the exact file this session
- Single obvious grep in one known file
- Pure write/generate task with zero exploration needed

## Usage

Use the `fastcontext` tool with these parameters:

```json
{
  "name": "fastcontext",
  "args": {
    "query": "Find where authentication middleware is defined and which routes use it",
    "maxTurns": 6,
    "citation": true
  }
}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | Natural-language exploration question. Be specific. |
| `maxTurns` | number | **8** | Exploration depth. Use 10-15 for complex traces, 4-6 for quick lookups. |
| `citation` | boolean | true | Return only compact file:line citations. |

### Examples

```json
// Precise answer with file:line citations (default 8 turns)
{ "query": "Locate the request validation logic in the user registration flow", "citation": true }

// Deep architecture trace
{ "query": "Trace how database migrations are loaded and applied on startup", "maxTurns": 12, "citation": true }

// Broader summary with explanations
{ "query": "How does the caching layer work and where is it configured?", "maxTurns": 10, "citation": false }
```

## Model Configuration

The model used by FastContext is set via `/model` for the **researcher** tier. It reads from `~/.superagent-r/model-config.json` — no environment variables needed.
