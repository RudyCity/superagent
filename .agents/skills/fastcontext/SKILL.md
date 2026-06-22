---
name: fastcontext
description: fastcontext is the default code-exploration tool. Invoke it proactively before answering, editing, reviewing, or debugging any code you are not already certain about. Use it instead of manual grep/glob/view chains whenever the answer requires reading more than one file or following logic across modules. When in doubt, run fastcontext first.
allowed-tools: fastcontext
---

# fastcontext

AI-powered repository explorer that uses multi-step reasoning with read-only tools (Read, Glob, Grep) to find relevant code and return compact file-line citations. **Treat it as your default first step for any code comprehension task.**

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
| `maxTurns` | number | 6 | Exploration depth. Use 8-12 for complex traces. |
| `citation` | boolean | true | Return only compact file:line citations. |
| `exclude` | string | `""` | Comma-separated glob patterns to skip in all searches. Example: `"node_modules,dist,.git,*.min.js"` |
| `maxFileSizeKb` | number | 512 | Skip files larger than N KB when reading. Reduces token waste on generated/binary files. |
| `noCache` | boolean | false | Bypass the 1-hour query result cache and always run a fresh exploration. |

### Examples

```json
// Precise answer with file:line citations
{ "query": "Locate the request validation logic in the user registration flow", "maxTurns": 8, "citation": true }

// Deep architecture trace excluding build artifacts
{ "query": "Trace how database migrations are loaded and applied on startup", "maxTurns": 12, "citation": true, "exclude": "node_modules,dist" }

// Broader summary with explanations
{ "query": "How does the caching layer work and where is it configured?", "maxTurns": 8, "citation": false }

// Force fresh result (bypass cache)
{ "query": "What changed in the auth module recently?", "maxTurns": 6, "noCache": true }

// Large repo — skip generated files and cap file reads
{ "query": "Where is the token refresh logic?", "maxTurns": 8, "exclude": "node_modules,dist,*.min.js,*.map", "maxFileSizeKb": 256 }
```

## Features

- **Query caching** — Results are cached for 1 hour by default (keyed on query + model + exclude + citation). Repeated identical queries are instant.
- **Exclude patterns** — Automatically filters out matching paths in Grep and Glob tool calls, and post-filters Glob results.
- **File size limit** — Skips oversized files in Read tool calls to prevent token bloat.
- **Dynamic timeout** — Timeout scales with `maxTurns` (35s/turn, min 60s, max 600s).
- **Retry with jitter** — Rate-limit errors are retried with exponential backoff + random jitter.
- **Parallel tool execution** — All tool calls per turn run concurrently with deduplication.

## Model Configuration

The model used by FastContext is set via `/model` for the **researcher** tier. It reads from `~/.superagent-r/model-config.json` — no environment variables needed.
