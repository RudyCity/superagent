# Project Specifications (agents.md)

This file contains key information about the project for AI agents to study and align with when working on Superagent.

## Project Overview
- **Name**: Superagent
- **Description**: An interactive, terminal-based AI coding assistant featuring a cyberpunk style terminal UI, context token tracking, and subagent orchestration.
- **Technology Stack**: Node.js, TypeScript, React, Ink (Terminal UI Components), Vercel AI SDK, Execa, Vitest

## Coding Guidelines & Constraints
- **Shell Commands**: On Windows (PowerShell/CMD), the statement separator for terminal commands MUST be `;` instead of `&&`. When invoking or proposing commands, ensure OS-compatibility checks are implemented.
- **Strict Naming Rules**: Do NOT mention proprietary brand names like "Claude Code" or generic "CLI" terms in user-facing documentation or UI descriptions. Refer to the project as a terminal-based AI coding assistant.
- **Workspace Isolation**: Configuration `.env`, logs (`superagent.log`), and session histories MUST be stored in the global home directory under `~/.superagent-r/` instead of cluttering the target project repository.
- **Interactive Prompts**: Ensure any executed shell command processes are monitored for interactive inputs (such as asking for yes/no confirmation) to alert the user rather than hanging in the background.
- **Test Location**: Always create and place all test files inside the `tests/` directory at the project root. Do not place test files under the `src/` directory.

## Verification Checklist
- Run `npm test` to verify that all unit tests pass before committing.
- Build the project using `npm run build` to verify there are no TypeScript compilation errors.

