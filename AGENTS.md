# SuperAgent Agent Instructions

Read and follow [the canonical project-scoped rules](.agents/AGENTS.md)
before investigating or changing this repository.

The runtime architecture is **one primary SuperAgent stack**, with
independently owned Core/MCP/OAuth services and, when needed, a bounded
private test profile. T-Line has one backend and selects one verified
Core target at startup. **Never hot-switch active sessions, stop legacy
owners from staging or migrate OAuth credentials without the R0-R7
release gates and operator approval.**

Keep this root entry short; update `.agents/AGENTS.md` as the
single source of truth rather than duplicating its rules here.
