# SuperAgent Core deployment — isolated live canary, not production 7888 cutover

Date: 26 October 2026
Source commit at deployment: c1f41b4e (other sessions may subsequently commit changes)
Build: superagent 1.14.36, Bun 1.4.2.

## Preflight and reason for safe deployment mode

- Global installation `C:\Program Files\nodejs\node_modules\superagent` is a junction to the SuperAgent repository. `dist/cli.js` bytes/hash match the global launcher path. Thus building the repository updates the **on-disk global installation**, but not JavaScript modules previously loaded into a live process.
- Production API port 7888 is held by PID 13424, an **unsupervised** global `dist/cli.js` process also hosting an active OAuth MCP/tunnel on port 6789. An additional CLI/MCP instance PID 10060 is active on another workspace/port.
- `core status --port 7888` reports no supervised core. `core lifecycle-observe --port 7888` assessed `UNKNOWN_PROCESS_OWNERSHIP`; `core boot-audit --port 7888` assessed `UNKNOWN_PUBLIC_PORT_OWNER`.
- The authenticated live GET `/api/status` on 7888 returned 200 with T-Line client mode but **without** the new `senopatiInference` field. This confirms the old in-memory API has **not** been rolled in place.
- This architecture cannot adopt an already-running unsupervised owner at 7888 without stopping the process, which would also drop its active MCP sockets. No blind process kill, forced port release, or credential overwrite is permitted.

## Deployment performed

- Built source successfully: `bun run build`, including TypeScript; 12/12 focused Core/session/reconnect tests passed.
- Started a **detached**, owner-isolated SuperAgent supervised Core **canary** at `127.0.0.1:7892`, under a distinct profile `~/.superagent-r/core-rollout-canary-7892`. Its env explicitly sets `SUPERAGENT_CORE_STAGING=1` and `SUPERAGENT_SENOPATI_AUTOSTART=0` to prevent launching another model or shared helpers.
- Canary supervisor PID **19352**; initial worker PID **34528**. Authenticated GET `/api/status` returned 200, unauthenticated GET 401, and new `senopatiInference` object showed degraded/legacy-active as appropriate for a separate staging profile without a model. No tool permission or chat replay was granted.
- Authenticated **rolling restart** on the canary kept supervisor PID 19352 and replaced worker PID 34528 with PID **33076**, initially retaining the old worker.
- Explicit owner-verified idle drain retired PID 34528 and left **zero retained workers**, active PID 33076 and supervisor port 7892 unchanged.
- No changes made to T-Line's hardcoded 7888 target, old Core PID 13424, other CLI sessions, running OAuth MCP listeners, or shared Senopati model and watchdog.

## Operator notes

- Canary control requests must set `SUPERAGENT_CONFIG_DIR` to its own profile before using `core status/restart/rollback/drain --port 7892`. Do **not** point an unauthenticated client at the private worker port.
- Core 7892 is a staging/canary profile and **does not contain production sessions or user configuration**. It is not the production API cutover; the T-Line desktop still targets 7888.
- Rollout to **production 7888** requires first separating the old core HTTP listener and its MCP/tunnel connection owner (or explicitly accepting a bounded maintenance interruption and reconnect). The current module cannot atomically inherit the active TCP listener and in-memory agent/MCP sessions from the old unsupervised process.
- Do not delete an existing checkpoint or assume worker termination proves side effects are reconciled. A production cutover requires new session/readiness and rollback evidence, plus separate MCP session ownership handling.
- This canary has no automatic OS-service restart guarantee and should not be presented as zero-downtime full production Core deployment.
