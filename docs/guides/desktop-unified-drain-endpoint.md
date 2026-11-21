# Desktop Unified Drain Architecture & REST Endpoint

## Overview

The Unified Drain Engine provides a safe, coordinated one-click teardown mechanism for all Superagent background daemons, MCP client servers, WebSocket tunnels, scheduled cron tasks, in-process subagents, and supervised Core API instances. It eliminates orphaned background tasks, freed memory, and prevents port collisions (such as port 7888 and MCP dynamic ports) during service restarts or system shutdown.

---

## 8-Stage Graceful Teardown Sequence

When triggered, the engine executes through an eight-phase dependency-ordered pipeline:

1. **Subagents & Active Remote Tasks**:
   - Inspects `subagentInstances` and gracefully calls `.abort()` on active subagent instances.
   - Signals `abortActiveRemoteTask("Stopped by unified drain")` for running remote executions.
   - Emits `notifySubagentsChanged()` to update attached UI observers.

2. **Daemon Cron Scheduler**:
   - Inspects `daemonScheduler.getStatus()`.
   - Calls `daemonScheduler.forceStopDaemon()` to cancel scheduled and active cron runs cleanly.

3. **MCP Clients & Tunnels**:
   - Calls `closeMcpServers()` to disconnect connected external client sessions.
   - Scans active tunnel ports via `listActiveMcpServers()`.
   - Resolves managed tunnel leases via `readManagedMcpTunnelLease` and invokes `stopManagedMcpTunnelOwner(port, { force: true })` or `stopMcpTunnel(port)`.

4. **Cloudflare Quick Tunnels**:
   - Enumerates active tunnels through `listActiveTunnels()`.
   - Halts all non-MCP tunnels via `stopQuickTunnel(port)`.

5. **Muse & Telegram Fallback Watchers**:
   - Halts owned WebSocket tunnels via `stopOwnedMuseTunnel(port)`.
   - Shuts down local Telegram and HTTP watchers via `stopAllMuseWatchers()`.

6. **Supervised Core API (Port 7888)**:
   - Dispatches a bounded 1.5s graceful drain request via `requestCoreSupervisor("drain", corePort, 1500)`.
   - Reads supervisor, worker, guardian, and server info state files (`core-supervisor-*.json`, `core-guardian-*.json`, `server-info-*.json`).
   - Terminates matching PIDs cleanly (`taskkill /PID <pid> /T /F` on Windows, `SIGKILL` on POSIX).
   - Deletes state lease files to mark the Core port quiescent and available.

7. **Lingering Background Daemons**:
   - Inspects OS processes (`Win32_Process` on Windows) matching `--mcp`, `senopati`, `core boot`, or `--server` CLI flags.
   - Terminates matching child processes while preserving the invoking process.

8. **Lingering Cloudflare Processes**:
   - Terminates orphaned `cloudflared.exe` processes to release system networking resources.

---

## REST API Interface

### Endpoint
`POST /api/desktop/drain-all`

### Request Headers
- `Content-Type: application/json`

### Request Body (Optional)
```json
{
  "corePort": 7888,
  "timeoutMs": 45000
}
```

### Response Schema (`UnifiedDrainReport`)
```typescript
export interface DrainStepResult {
  name: string;
  ok: boolean;
  message: string;
  durationMs?: number;
}

export interface UnifiedDrainReport {
  ok: boolean;
  timestamp: number;
  durationMs?: number;
  steps: DrainStepResult[];
}
```

### Example Successful Response (HTTP 200)
```json
{
  "ok": true,
  "timestamp": 1732159695000,
  "durationMs": 482,
  "steps": [
    {
      "name": "Subagents & Active Tasks",
      "ok": true,
      "message": "No active tasks or subagents running.",
      "durationMs": 2
    },
    {
      "name": "Daemon Cron Scheduler",
      "ok": true,
      "message": "Daemon scheduler was already inactive.",
      "durationMs": 1
    },
    {
      "name": "MCP Clients & Tunnels",
      "ok": true,
      "message": "Disconnected client connections; stopped 0 active MCP tunnel owner(s).",
      "durationMs": 15
    },
    {
      "name": "Cloudflare Quick Tunnels",
      "ok": true,
      "message": "No active Cloudflare quick tunnels found.",
      "durationMs": 3
    },
    {
      "name": "Muse & Telegram Watchers",
      "ok": true,
      "message": "Stopped 0 local watcher(s) and associated WebSocket tunnels.",
      "durationMs": 5
    },
    {
      "name": "Supervised Core API",
      "ok": true,
      "message": "Port 7888: Core was already inactive or stopped.",
      "durationMs": 45
    },
    {
      "name": "Superagent Background Daemons",
      "ok": true,
      "message": "No lingering background daemons or MCP processes found.",
      "durationMs": 410
    },
    {
      "name": "Cloudflare Daemon Processes",
      "ok": true,
      "message": "No lingering cloudflared processes found.",
      "durationMs": 1
    }
  ]
}
```

---

## Desktop Tray Integration

The Superagent Tray application integrates with this pipeline via:

1. **UI Action**:
   - **Drain All** button in the Lifecycle Console (`#op-drain-all`).
   - Quick action tile **Drain All** (`#overview-action-drain-all`) on the Tray Overview dashboard.
2. **User Confirmation**:
   - Triggers native confirmation prompt: *"Are you sure you want to stop and close ALL Superagent background daemons, MCP servers, and Core services?"*
3. **Tauri IPC Command**:
   - Invokes `drain_all_services(app, window)` which gives Core up to 1.5s for memory flushing before executing native OS-level cleanup.
   - Emits event `desktop-server-stopped` with port `7888` to update UI status indicators immediately.

---

## CLI Usage

Superagent can also trigger this teardown from any terminal:

```bash
# Graceful one-click drain of all local services
superagent drain all

# Drain on a custom Core port
superagent drain all --port 7889
```

---

## Telemetry & Observability

Every execution of `drainAllServices()` logs structured duration metrics to `unifiedLogger.ts`:
- Category: `"PERF"`
- Event Message: `[unifiedDrain] Completed teardown in {durationMs}ms (allOk={allOk})`
- Metadata payload includes per-step timing breakdown and targeted Core port for diagnostic analysis.
