---
name: Superagent CLI Automation
description: Guide for AI agents to control, configure, and automate Superagent via non-interactive CLI commands (login, model presets, one-shot prompts, workspaces, and sessions).
when_to_use: when an AI agent (Claude Code, AGY, Codex, CI/CD, or automated script) needs to configure or invoke Superagent non-interactively via shell commands without terminal UI prompts
version: 1.0.0
languages: all
dependencies: superagent CLI binary
---

# Superagent CLI Automation

## Overview

Superagent is an interactive and automated AI coding assistant with single-agent and 3-tier multi-agent orchestration. While human users typically use the interactive cyberpunk terminal UI, external AI agents (such as Antigravity, Claude Code, OpenAI Codex, custom CI/CD runners, or shell scripts) can operate Superagent non-interactively using dedicated CLI subcommands and command-line flags.

This skill teaches AI agents how to configure provider credentials, select model presets, run one-shot tasks, and manage sessions cleanly through standard shell commands without getting blocked by interactive prompts.

---

## Quick Reference Table

| Goal | CLI Command | Notes |
|---|---|---|
| View help & options | `superagent --help` | Displays all CLI subcommands and options |
| List providers | `superagent login list` | Lists configured provider profiles, active profile, and masked keys |
| Add provider key | `superagent login add <provider> <api_key> [base_url]` | Supported providers: openrouter, anthropic, openai, gemini, opencode, deepseek, xai, groq, etc. |
| Auto-detect key | `superagent login add <api_key>` | Auto-detects OpenRouter (`sk-or-`), Anthropic (`sk-ant-`), Gemini (`AIza`), or OpenAI |
| Add custom endpoint | `superagent login add custom <base_url> <api_key>` | Connects to custom OpenAI/Anthropic compatible endpoints |
| Switch active provider | `superagent login use <provider_id>` | Sets default active provider profile |
| Remove provider | `superagent login remove <provider_id>` | Deletes provider profile from configuration |
| List presets | `superagent preset list` | Displays presets for both multi-agent and single-agent modes |
| Activate preset globally | `superagent preset use <preset_name> [--single]` | Persists preset choice to `model-config.json` |
| Inspect preset | `superagent preset show <preset_name> [--single]` | Shows tier models defined inside the preset |
| One-shot task | `superagent "<prompt>"` | Executes prompt headless and exits |
| Run task with preset | `superagent --preset <preset_name> "<prompt>"` | Runs one-shot task with specific preset in-memory |
| Run task with model | `superagent --model <model_name> "<prompt>"` | Runs one-shot task with specific model override |
| Multi-agent task | `superagent --multi --preset <name> "<prompt>"` | Spawns 3-tier master orchestrator with feature worktrees |
| Target workspace | `superagent -w /path/to/project "<prompt>"` | Runs task inside target directory |
| List sessions | `superagent session list -w <dir>` | Lists conversation transcripts and message counts |
| Export session log | `superagent session export <session_id> -o log.md` | Exports chat transcript to Markdown or JSON |
| Clear empty sessions | `superagent session clear --empty` | Purges zero-message draft sessions |

---

## Workflow Patterns for External Agents

### 1. First-Time Setup: Authenticate Provider

Before executing AI tasks, ensure at least one provider credentials profile is configured.

```bash
# Check existing providers
superagent login list

# Add an OpenRouter key
superagent login add openrouter sk-or-v1-xxxxxxxxxxxxxxxxxxxx

# Or add an Anthropic key
superagent login add anthropic sk-ant-xxxxxxxxxxxxxxxxxxxx

# Or add a local Ollama / custom OpenAI endpoint
superagent login add custom http://localhost:11434/v1 sk-ollama
```

All credentials are saved automatically to `~/.superagent-r/model-config.json`.

### 2. Choose or Verify Model Presets

Superagent separates model configurations into presets for Single-Agent and Multi-Agent modes:

```bash
# View available presets
superagent preset list

# Inspect what models are inside a preset
superagent preset show dev

# Activate the "dev" preset globally for multi-agent workflows
superagent preset use dev

# Or activate for single-agent workflows
superagent preset use dev --single
```

### 3. Running Headless Tasks Non-Interactively

When automating tasks from an external agent or script, combine workspace isolation, preset selection, and headless execution:

#### Single-Agent One-Shot Task
```bash
superagent -w /path/to/project --preset dev "Audit tests/auth.test.ts and fix any failing test cases"
```

#### Multi-Agent Orchestrator Task
```bash
superagent -w /path/to/project --multi --preset dev "Implement OAuth2 Google authentication with unit tests"
```

In multi-agent mode (`--multi`), the Master Agent delegates feature development into isolated git worktrees (`~/.superagent-r/worktrees/<name>`), runs subagents, verifies changes, and merges back cleanly.

### 4. Inspecting and Exporting Results

After Superagent runs, external agents can retrieve the session transcript:

```bash
# List recent sessions
superagent session list -w /path/to/project

# Export transcript for analysis
superagent session export sess_xxxx -o ./audit-report.md
```

---

## Critical Rules for AI Agents Invoking Superagent

- **Do Not Launch Interactive Prompts**: Never call `superagent` without arguments or prompts in a non-interactive subprocess, as it launches the TUI dashboard. Always supply a prompt or subcommand.
- **PowerShell Compatibility**: On Windows PowerShell, command separators must be `;` instead of `&&`.
- **Quote Escaping**: When passing complex prompts with quotes or code snippets, wrap the prompt string in double quotes and escape internal quotes:
  ```bash
  superagent "Refactor function \"getUser\" in src/auth.ts"
  ```
- **Use `--preset` or `--model` for Controlled Cost**: Default or unset models may hit fallback endpoints. Always specify an explicit preset (e.g. `--preset dev`) or model override (e.g. `--model openai/gpt-4o-mini`) when budget or speed is a priority.
