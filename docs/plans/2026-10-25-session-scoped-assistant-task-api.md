# Session-scoped persistent task API — implementation increment (2026-10-25)

## Shipped source increment

The API Core exposes an **operator-visible task draft journal** through `/api/assistant/tasks` using the previously built task store.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/assistant/tasks` | List at most 100 tasks in the owning active T-Line session |
| GET | `/api/assistant/tasks/events?cursor=N` | Read at most 100 sequenced persisted state events |
| GET | `/api/assistant/tasks/:id` | Inspect one task in the owning session |
| POST | `/api/assistant/tasks` | Idempotently create a **draft**, initially queued; does **not** spawn an agent |
| POST | `/api/assistant/tasks/:id/cancel` | Cancel a **queued** draft with its expected revision |

All URLs require explicit `sessionId` and `workspace` query parameters plus matching `x-workspace-path` and `x-client-mode: tline` headers. Global Core HTTP bearer authorization and trusted-workspace resolution must succeed before route dispatch. The API resolves the active server-owned session and rejects workspace, mode and session mismatches; callers cannot select an arbitrary `ownerId` or `workspaceId`. Persisted journal namespace is derived from the validated session ID and workspace, with no plaintext session key in the journal filename. Responses use `Cache-Control: no-store`.

**Important:** Core bearer authentication and session-scoped routing are local operator boundaries, not a multi-user RBAC solution. The task metadata journal does not store prompts, worker credentials or approval grants. A client-supplied session ID is not standalone authentication.

## Safety and limitations

- `executionEnabled: false` is explicitly returned. Draft task creation and cancellation do not dispatch agents, invoke shell tools, run browser actions, retry unknown side effects, or manage daemon jobs.
- The endpoint rejects unknown verbs/actions. It has no generic command proxy.
- The route requires an existing active T-Line session. After an API crash or a supervised restart, clients must safely reinitialize the same session to resume the journal view; **active model/tool execution is not checkpointed or adopted**.
- In-memory dispatcher jobs and disk metadata are intentionally separate until a trusted worker adapter and reconciler exist. `queued` means draft, not background execution.
- Journal validity, maximum record count and event size are bounded. Full transactional multi-process execution, resuming an interrupted job, retained worker draining and cross-device permission checks remain unfinished.

## Verification

- `bun run build`
- `bun --bun x vitest run tests/assistantTaskHttpRoutes.test.ts tests/assistantTaskStore.test.ts tests/assistantTaskDispatcher.test.ts`

Focused tests assert idempotent draft creation, session/workspace/header mismatch denial, event cursor, queued cancellation and optimistic revision handling. They do not constitute a live desktop, network-origin, packaged-app or multi-model E2E acceptance test.

## Next implementation phase

1. Authenticated canonical **goal execution** endpoint with explicit capability profile and trusted worker factory (no arbitrary callback/URL/command).
2. Ownership-bound execution leases and durable checkpoint/reconcile semantics for a crashed or detached worker.
3. Agent/Brain/daemon adapter and evidence-backed running/completed states; no inference from logical task status.
4. Bounded replay streaming, cancel/steer/approve and accurate resource conflict visibility in the desktop UI.
5. Real parallel execution/reconnect/authorization E2E and packaged-app verification.
