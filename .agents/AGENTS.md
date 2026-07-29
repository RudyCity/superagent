# Project-Scoped Rules (Superagent Workspace)

## Response Formatting

- **No markdown decoration in AI responses**: Do NOT use `**bold**`, `##` headings, `*italic*`, `__underline__`, or any other markdown formatting syntax in AI-generated responses or tool output intended for the terminal. Plain prose and single-level bullet points (`-`) are allowed. This applies to all agents (Master, Superagent, Subagent) and all user-facing text.
- **Display File Changes**: In every superagent process, if there are file changes (created, modified, or deleted files), they MUST always be displayed at the end of the response.

## Mandatory Skills

- **Design Tasks**: When building, designing, or refactoring user interfaces, layouts, components, or web applications, you MUST treat the hallmark skill (.agents/skills/hallmark/SKILL.md) as a mandatory skill and read its instructions using the view_file tool before proceeding.
- **Debugging Tasks**: When investigating bugs, runtime errors, failures, or diagnosing issues, you MUST treat the non-linear-debugging skill (.agents/skills/non-linear-debugging/SKILL.md) as a mandatory skill and read its instructions using the view_file tool before proceeding.
