---
name: fastcontext
description: fastcontext is the default code-exploration agent. Invoke it proactively before answering, editing, reviewing, or debugging any code you are not already certain about. Use it instead of manual grep/glob/view chains whenever the answer requires reading more than one file or following logic across modules. When in doubt, run fastcontext first.
allowed-tools: Bash(fastcontext *)
---

# fastcontext

Fast, autonomous subagent that explores codebases through multi-step reasoning. **Treat it as your default first step for any code comprehension task.**

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

```bash
# Precise answer with file:line citations
fastcontext -q "<detailed question>" --max-turns 8 --citation

# Deep traces or architecture questions
fastcontext -q "<complex question>" --max-turns 12 --citation

# Broader summary with explanations (may include some noise)
fastcontext -q "<question>" --max-turns 8
```
