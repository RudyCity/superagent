# Changelog

All notable changes to this project will be documented in this file.

## [1.1.27] - 2026-06-11

### Added
- **Session Checkpoints**: Added a session checkpointing mechanism (`/checkpoint` command, interactive `Ctrl+P` wizard) to save, list, and restore previous states/history in the CLI.
- **Dynamic Project Detection**: Implemented auto-detection of project name, description, and technology stack (from `package.json`, `Cargo.toml`, `go.mod`, etc.) during system setup.
- **Git Metadata Audit**: Display current Git branch, HEAD commit hash, and status in the initialization (`/init` command) system audit log.
- **Karpathy Coding Guidelines Skill**: Integrated Andrej Karpathy's coding guidelines to reduce agent errors.

---

## [1.1.0] - 2026-06-10

### Added
- **Cyberpunk Terminal Styling**: Added customized terminal UI components, user narratives, an ASCII banner on start, and colors (magenta, cyan, yellow, green).
- **`/init` Slash Command**: A new command to initialize project settings and configuration setup.
- **Global Config Path (`~/.superagent-r`)**: Relocated environment configurations (`.env`), history records (`history/`), and execution logs (`superagent.log`) to a global user profile folder to prevent polluting project directories.
- **Context Usage Tracker**: Enhanced status bar displaying message count, active model name, current working directory, uploaded / downloaded tokens, and context window consumption percentage (`CTX_USAGE`).
- **Console Clear on Startup**: Interactive terminal clears output before rendering the UI layout.
- **Strict Guidelines & Safety Controls**: Added clear developer guidelines, PowerShell command compatibility (using `;` instead of `&&` on Windows), and mandatory planning phase (`implementation_plan.md`) workflows for complex changes.

### Changed
- Refactored history loading and logging routines to write and load from `~/.superagent-r` instead of process working directory.
- Adjusted CLI terminal layout and height calculations to accommodate the new multi-line status bar.

---

## [1.0.0] - 2026-06-10

### Added
- Initial release of Superagent, an interactive CLI coding agent.
- Integration with Anthropic and OpenAI via AI SDK.
- CLI Terminal interface using Ink (React-based terminal rendering engine).
- File reading, file writing, command execution, and permission confirmation mechanisms.
