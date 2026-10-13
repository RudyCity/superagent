# Plan: Harden and Modularize Muse MCP / Chat Flow

## Goal
Implement six improvements to the current SuperAgent MCP + Muse integration: remove manual tool-count drift, split remote-agent MCP tools into smaller modules, add explicit direct-chat readiness/status, formalize the chat protocol for correlated replies, add integration tests for the new flow, and document usage examples.

## Scope
1. Eliminate hardcoded MCP tool counts and derive the exposed tool count from the actual registry.
2. Split the remote-agent MCP tools into smaller modules so tunnel, Telegram, and two-way chat are isolated and easier to maintain.
3. Add a direct-chat readiness/status utility so the system can report whether Muse two-way chat is currently possible.
4. Formalize chat envelopes and prompt guidance for correlated replies using reply_to / message correlation.
5. Add integration tests that cover request/reply correlation, timeout handling, and disconnected behavior.
6. Update docs/changelog with examples and the correct use-cases for tunnel restart vs Telegram vs two-way chat.

## Guardrails
- Preserve existing user changes; inspect git status before editing.
- Never log or return secrets.
- Keep the new two-way chat tool dangerous/opt-in.
- Prefer small, testable modules and reuse the existing Muse watcher and transport implementation.
- Do not claim live Muse connectivity unless it is verified in runtime.

## Acceptance Criteria
- Tool count is derived from the registry or a helper, not manually duplicated.
- Remote-agent MCP tools are separated into smaller files while preserving behavior.
- There is a direct-chat status helper and the new MCP tool uses it.
- Chat envelopes can carry reply correlation and tests validate the full request/reply path.
- Build and focused tests pass.
- Documentation explains which tool to use for each workflow.
