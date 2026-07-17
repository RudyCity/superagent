---
name: Remembering Conversations
description: Search previous Claude Code conversations for facts, patterns, decisions, and context using semantic or text search
when_to_use: when partner mentions past discussions, debugging familiar issues, or seeking historical context about decisions and patterns
version: 1.1.0
---

# Remembering Conversations

Search archived conversations using semantic similarity or exact text matching.

**Core principle:** Search before reinventing.

**Announce:** "I'm searching previous conversations for [topic]."

**Setup:** See INDEXING.md

## When to Use

**Search when:**
- Your human partner mentions "we discussed this before"
- Debugging similar issues
- Looking for architectural decisions or patterns
- Before implementing something familiar

**Don't search when:**
- Info in current conversation
- Question about current codebase (use Grep/Read)

## In-Session Use (for AI Agents)

Use these native tools directly:
- `rmemory_search`: Search through long-term structured memories (L1).
- `rmemory_conversation_search`: Search past raw conversation exchanges (L0).
- `rmemory_save`: Save a structured memory (L1) to project or global scope.

## Direct Search & Configuration (for Humans)

Use these slash commands in the CLI:
- `/memory search <query>`: Semantic search through long-term memories.
- `/memory status`: Check RMemory status and current session key.
- `/memory add <key> <value>`: Save/overwrite a long-term memory.
- `/memory delete <key>`: Delete a memory.
- `/setting-rmemory <on|off>`: Toggle RMemory.
- `/setting-rmemory provider <local|openai>`: Set embedding provider.
