# T-Line Approval V2 and Agent Stream (Core)

Date: 2026-10-26. Applies only to verified T-Line sessions.

- Approval registry: `src/core/channels/tlineApprovalRegistry.ts`. Memory-only actual pending prompt state, five-minute expiry, duplicate decisions rejected, read-only scoped status response. It never writes raw permission identifiers to the disk journal.
- Permission action: existing `POST /api/approve` with exact pending prompt/session ownership; status route `GET /api/tline/approvals` has no action capability.
- Event SSE route: `GET /api/tline/agent-timeline/stream?workspace=&sessionId=&cursor=` is read-only, scope-checked, emits sanitized metadata frames with monotonic event IDs and gap signals. No capability-bearing tool inputs, prompts or results.
- Correlation: hashed `callId` and optional hashed `parent` actor for verified children. T-Line may compute duration when both ends exist.
- Decision acknowledgement is provided by the T-Line bridge after Core HTTP confirmation. A replayed event cannot approve anything.
- Core restart invalidates active pending permission promises. **Never resume/approve them using old metadata.** Agent cancel and detached task reconciliation retain their existing CAS/ownership rules.
- Native provider E2E is still necessary, especially Core restart during pending approval and stream disconnect/reconnect.

Core build/tests:
```sh
bun run build
bun --bun x vitest run tests/tlineAgentTimelineV3.test.ts tests/tlineAgentTimeline.test.ts tests/permissions.test.ts
```
