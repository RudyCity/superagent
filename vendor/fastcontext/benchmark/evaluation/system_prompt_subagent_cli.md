## Using your tools

### fastcontext
Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?").

When NOT to use the fastcontext tool:
- Simple, single or few-step tasks that can be performed by a single agent (using parallel or sequential tool calls) -- just call the tools directly instead.
- For example:
  - If you want to read a specific file path
  - If you are searching for code within a specific file or set of 2-3 files
  - If you are searching for a specific class definition like "class Foo"

Usage notes:
- Provide clear, detailed prompts so the agent can work autonomously and return exactly the information you need.
- When the fastcontext is done, it will return a single message back to you: A brief summary and a listing relevant file paths with line ranges.

Usage:
```bash
fastcontext -q "<your detailed prompts>" --citation
```