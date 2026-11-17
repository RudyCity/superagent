# ChatGPT.com → SuperAgent → ChatGPT.com persistent lifecycle

Status: implemented in repository source. An installed Core/Tray/MCP update and live ChatGPT.com end-to-end verification remain separate release gates.

## Security boundary

- MCP must NEVER spawn, message, pause, resume, interrupt or control internal SuperAgent agents. Existing MCP policy keeps these operations disabled.
- External workflow tools are separate: superagent_lifecycle requires a verified MCP connection, explicit project execute grant, host Security Approval and OAuth write scope when applicable. superagent_lifecycle_status only reads project-scoped counts.
- Workers explicitly register, claim, renew and complete tasks through their own MCP permissions. A task prompt or worker label never grants tools, filesystem access, YOLO or control over SuperAgent agents.
- A CDP wake-up only notifies a previously paired, operator-approved, exact idle ChatGPT tab. The worker must still claim through MCP before acting. Neither notification delivery nor a model response constitutes a verified completed task.
- The local native Tray is the only operator surface for binding CDP targets, revoking workers or reviewing an uncertain task; no such power is given to MCP.

## Workflow

1. Start the existing SuperAgent Core daemon scheduler. The Tray remains a management UI and does not run a separate scheduler.
2. ChatGPT A calls superagent_lifecycle with action=create, a registered projectId, name, five-field cronExpression, and either prompt or DAG steps. Optional maxRuns=1 makes the workflow one-shot.
3. ChatGPT B connects using an independently approved MCP session and calls action=worker.register, retaining its returned workerId and private resumeToken. Worker identity is bound to verified MCP transport, not clientInfo or tool-supplied identity.
4. In Tray → Schedules & Reminders → ChatGPT ↔ ChatGPT Workflows, the operator may optionally bind B to the exact ready ChatGPT.com tab returned by paired Chrome Delegate detection.
5. At the due minute, the scheduler persists a single workflow run. Independent DAG roots can be claimed in parallel by different workers; prerequisites are exposed only when all upstream steps have completed.
6. An active worker calls action=worker.claim, receives the scoped task prompt and an expiring lease. It performs work under its own MCP grants, renews long leases, and returns action=worker.complete with exact runId, stepId, workerId and leaseToken.
7. Results become a durable checkpoint. On error or expired lease, the run enters failed/review_required. An uncertain side effect is never automatically replayed. Local operator review is required for retry.
8. Optional CDP notification uses the existing Delegate bridge to deliver a single no-secret wake-up to an operator-approved tab. No browser/tab auto-selection or fallback is allowed.

## Example MCP calls

ChatGPT A schedules a daily review:

~~~json
{"action":"create","projectId":"approved-project-id","name":"Daily CI review","cronExpression":"0 8 * * *","steps":[{"id":"audit","prompt":"Inspect GitHub Actions and report grounded failures","dependsOn":[]},{"id":"review","prompt":"Verify audit evidence","dependsOn":["audit"]}]}
~~~

ChatGPT B opts in:

~~~json
{"action":"worker.register","projectId":"approved-project-id","label":"ChatGPT B","capabilities":["review"]}
~~~

While active, ChatGPT B claims and completes work:

~~~json
{"action":"worker.claim","projectId":"approved-project-id","workerId":"life_worker_RETURNED_BY_REGISTER"}
~~~

~~~json
{"action":"worker.complete","projectId":"approved-project-id","workerId":"life_worker_RETURNED_BY_REGISTER","runId":"life_run_RETURNED_BY_CLAIM","stepId":"audit","leaseToken":"PRIVATE_PROOF_RETURNED_BY_CLAIM","outcome":"completed","result":"Verified evidence and outcome"}
~~~

The actual resumeToken and leaseToken are secrets. Do not paste them into logs or unrelated conversations. The agent may reconnect using action=worker.resume only with its original authenticated principal and private resume proof.

## Availability and recovery limitations

- MCP standard tools do not awaken a closed ChatGPT.com conversation. An active worker must poll/claim voluntarily; optionally the host can notify an exact approved, connected, idle CDP tab.
- If the Core daemon scheduler is stopped, scheduled jobs are not dispatched. Missed historic cron windows are not automatically backfilled on restart.
- Runs, workers, bindings, and no-replay delivery receipts persist beneath the shared SuperAgent configuration directory in external-lifecycle/state.json, with atomic writes and a cross-process lock. A corrupt store or stale lock fails closed for operator review.
- One worker can hold one active stage lease; independent workers can work on separate stages concurrently.
- Every MCP tool call must pass project-scoped authentication and Security Approval. Chat Agent YOLO cannot elevate MCP.
- A delivered CDP message is not a task-completion signal. Only a matching worker completion receipt may close a task.

## Verification

Run on an authorised development checkout:

~~~bash
bun run build
bun --bun x vitest run tests/externalLifecycle.test.ts tests/daemonScheduler.test.ts tests/mcpServer.test.ts --maxWorkers=2
bun run tray:check
bun run tray:test
~~~

Live acceptance requires two authenticated ChatGPT sessions, exact CDP profile/tab verification, schedule/claim/complete, parallel DAG, disconnected worker queue, Core restart, lease expiry, worker revocation, and negative MCP internal-agent control tests. Source and CI passing are not proof of installed-client end-to-end operation.
