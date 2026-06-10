# Superagent 🚀

Superagent is an interactive, terminal-based AI coding assistant designed to help developers build, debug, and optimize applications directly from the command line. Inspired by tools like Claude Code, it features a rich terminal interface with cyberpunk styling, a live context usage tracker, and robust command execution/permission controls.

---

## Key Features

- **Cyberpunk Terminal UI**: Visual design with ASCII banners, cyberpunk styling, and real-time status details.
- **Context Usage Tracker**: Real-time visualization of prompt size, completion token count, message history size, active LLM model, and system context limits.
- **Global Config Path**: Configuration `.env`, command log (`superagent.log`), and history files are stored securely in `~/.superagent-r` (global user directory), preventing clutter in project repositories while keeping user session states globally accessible.
- **Permissions Control**: Prompts users before running system commands or reading/writing files, ensuring execution safety.
- **Resumable Sessions**: Automatically resumes previous sessions using the `--resume` or `-r` flags.
- **Structured Planning Mode**: For complex changes, Superagent drafts an `implementation_plan.md` in the workspace root, requiring user approval before modifying code.
- **Robust String Matching**: File-editing tools normalize whitespace and line endings to make search-and-replace modifications extremely robust.
- **Structured Patching (`apply_patch`)**: Supports applying standard unified search-and-replace/diff patches safely.
- **Built-in Git & Visual Helpers**: Real-time git status/diff/commit integration and desktop screenshot capturing on Windows (`screenshot`) for remote visual debugging.
- **Interactive Prompt Detection**: Detects if standard system commands attempt to trigger an interactive prompt, providing clear warning notices.

---

## Installation & Setup

### Prerequisites

- **Node.js** (v18 or higher recommended)
- **npm** or another package manager
- **API Keys**: Access to OpenAI or Anthropic Claude API.

### Setup Instructions

1. Clone or download the repository to your local machine:
   ```bash
   git clone <repository-url>
   cd superagent
   ```

2. Install the project dependencies:
   ```bash
   npm install
   ```

3. Setup your global environment configurations:
   Create a `.env` file inside the `~/.superagent-r/` directory (e.g. `C:\Users\<Your-Username>\.superagent-r\.env` on Windows or `/home/<username>/.superagent-r/.env` on macOS/Linux) with the following variables:
   ```env
   # API Keys (Provide at least one)
   ANTHROPIC_API_KEY=your_anthropic_api_key
   OPENAI_API_KEY=your_openai_api_key

   # Selected Provider (anthropic or openai)
   PROVIDER=anthropic

   # Selected Model
   MODEL=claude-3-5-sonnet-20241022
   ```

---

## Commands & Usage

### Running in Development Mode
To start Superagent in development mode:
```bash
npm run dev
```

### Resume Previous Conversation
To run and resume the last session:
```bash
npm run dev -- --resume
# or
npm run dev -- -r
```

### Building the Project
To compile the TypeScript source code into production JavaScript:
```bash
npm run build
```

### Running the Production Build
Once built, run the application using:
```bash
npm start
```

### Running Unit Tests
Superagent features a Vitest-based test suite for verifying config, conversations, tool helpers, and file operations:
```bash
npm test
```

---

## Global Directory Architecture

Superagent organizes its data globally inside `~/.superagent-r` to isolate development metadata from target project folders:

```
~/.superagent-r/
├── .env                # Global API keys and provider configuration
├── superagent.log      # Application execution logs
└── history/            # Saved interactive history categorized by project paths
    └── _path_to_project.json
```

---

## License

This project is licensed under the MIT License.
