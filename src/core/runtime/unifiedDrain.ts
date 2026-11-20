/**
 * Unified Drain Engine for Superagent.
 * Orchestrates one-click graceful shutdown across:
 * 1. In-process Subagents & active remote tasks
 * 2. Background Daemon & Cron Scheduler
 * 3. MCP client servers, tunnels, and managed tunnel owners
 * 4. Cloudflare quick tunnels & child cloudflared processes
 * 5. Muse WebSocket tunnels & local Telegram fallback watchers
 * 6. Supervised Core API idle/retained generation draining
 */

export interface DrainStepResult {
  name: string;
  ok: boolean;
  message: string;
}

export interface UnifiedDrainReport {
  ok: boolean;
  timestamp: number;
  steps: DrainStepResult[];
}

export async function drainAllServices(options?: {
  corePort?: number;
  timeoutMs?: number;
}): Promise<UnifiedDrainReport> {
  const steps: DrainStepResult[] = [];
  const corePort = options?.corePort || 7888;

  // 1. In-memory Subagents & Active Remote Tasks
  try {
    const { subagentInstances, notifySubagentsChanged } = await import("../tools/state.js");
    let abortedCount = 0;
    for (const inst of subagentInstances.values()) {
      if (inst.status === "running" && inst.agent && typeof (inst.agent as any).abort === "function") {
        try {
          (inst.agent as any).abort();
          abortedCount++;
        } catch {}
      }
    }
    if (abortedCount > 0) notifySubagentsChanged();

    try {
      const { abortActiveRemoteTask, getActiveRemoteTaskId } = await import("../remoteAgent/taskRunner.js");
      if (getActiveRemoteTaskId()) {
        await abortActiveRemoteTask("Stopped by unified drain");
        abortedCount++;
      }
    } catch {}

    steps.push({
      name: "Subagents & Active Tasks",
      ok: true,
      message: abortedCount > 0
        ? `Aborted ${abortedCount} active task(s)/subagent(s).`
        : "No active tasks or subagents running.",
    });
  } catch (error) {
    steps.push({
      name: "Subagents & Active Tasks",
      ok: false,
      message: `Failed to abort subagents: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // 2. Background Daemon & Cron Scheduler
  try {
    const { daemonScheduler } = await import("../daemon/daemonScheduler.js");
    const status = daemonScheduler.getStatus();
    const stopped = daemonScheduler.forceStopDaemon();
    steps.push({
      name: "Daemon Cron Scheduler",
      ok: true,
      message: status.running
        ? `Scheduler stopped (cancelled ${stopped.cancelledRuns} active run(s)).`
        : "Daemon scheduler was already inactive.",
    });
  } catch (error) {
    steps.push({
      name: "Daemon Cron Scheduler",
      ok: false,
      message: `Failed to stop daemon scheduler: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // 3. MCP Client Servers & Tunnels
  const handledMcpPorts = new Set<number>();
  try {
    const { closeMcpServers } = await import("../mcp/McpManager.js");
    await closeMcpServers();

    const { listActiveMcpServers, stopMcpTunnel } = await import("../mcp/mcpTunnel.js");
    const { readManagedMcpTunnelLease, stopManagedMcpTunnelOwner } = await import("./mcpManagedTunnelOwner.js");
    const mcpServers = listActiveMcpServers();
    let mcpStoppedCount = 0;

    for (const server of mcpServers) {
      handledMcpPorts.add(server.port);
      if (server.pid !== process.pid) {
        let lease = null;
        try { lease = readManagedMcpTunnelLease(server.port); } catch {}
        if (lease && lease.pid === server.pid) {
          try {
            const stopped = await stopManagedMcpTunnelOwner(server.port, { force: true });
            if (stopped.stopped) mcpStoppedCount++;
          } catch {}
          continue;
        }
      }
      try {
        await stopMcpTunnel(server.port);
        mcpStoppedCount++;
      } catch {}
    }

    steps.push({
      name: "MCP Clients & Tunnels",
      ok: true,
      message: `Disconnected client connections; stopped ${mcpStoppedCount} active MCP tunnel owner(s).`,
    });
  } catch (error) {
    steps.push({
      name: "MCP Clients & Tunnels",
      ok: false,
      message: `MCP shutdown error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // 4. Cloudflare Quick Tunnels
  try {
    const { listActiveTunnels, stopQuickTunnel } = await import("../remoteAgent/cloudflareTunnel.js");
    const tunnels = listActiveTunnels();
    let tunnelsClosed = 0;

    for (const tunnel of tunnels) {
      if (handledMcpPorts.has(tunnel.port) && tunnel.serviceKind === "mcp-http") continue;
      try {
        const stopped = await stopQuickTunnel(tunnel.port, tunnel.serviceKind || undefined);
        if (stopped) tunnelsClosed++;
      } catch {}
    }

    steps.push({
      name: "Cloudflare Quick Tunnels",
      ok: true,
      message: tunnelsClosed > 0
        ? `Stopped ${tunnelsClosed} active Cloudflare quick tunnel(s).`
        : "No active Cloudflare quick tunnels found.",
    });
  } catch (error) {
    steps.push({
      name: "Cloudflare Quick Tunnels",
      ok: false,
      message: `Failed to stop Cloudflare tunnels: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // 5. Muse & Telegram Fallback Watchers
  try {
    const { stopOwnedMuseTunnel } = await import("../remoteAgent/museWatcherTunnel.js");
    const { stopAllMuseWatchers } = await import("../remoteAgent/museWatcher.js");
    const { listActiveTunnels } = await import("../remoteAgent/cloudflareTunnel.js");

    const tunnels = listActiveTunnels();
    const museTunnels = tunnels.filter((t) => t.serviceKind === "muse-websocket");
    for (const tunnel of museTunnels) {
      try { await stopOwnedMuseTunnel(tunnel.port); } catch {}
    }

    const watcherCount = await stopAllMuseWatchers();
    steps.push({
      name: "Muse & Telegram Watchers",
      ok: true,
      message: `Stopped ${watcherCount} local watcher(s) and associated WebSocket tunnels.`,
    });
  } catch (error) {
    steps.push({
      name: "Muse & Telegram Watchers",
      ok: false,
      message: `Failed to stop Muse watchers: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // 6. Supervised Core API (Stop supervisor and all workers completely)
  try {
    const fs = await import("fs");
    const path = await import("path");
    const { getRootConfigDir } = await import("../config/paths.js");
    const configDir = getRootConfigDir();

    // 6a. Try graceful drain first if responsive (bounded to 1.5s)
    try {
      const { requestCoreSupervisor } = await import("./coreSupervisor.js");
      await requestCoreSupervisor("drain", corePort, 1500).catch(() => {});
    } catch {}

    // 6b. Directly terminate Core supervisor, workers, and guardian PIDs
    const supervisorFile = path.join(configDir, `core-supervisor-${corePort}.json`);
    const serverInfoFile = path.join(configDir, `server-info-${corePort}.json`);
    const checkpointFile = path.join(configDir, `core-checkpoint-${corePort}.json`);
    const guardianFile = path.join(configDir, `core-guardian-${corePort}.json`);
    const globalServerInfo = path.join(configDir, "server-info.json");

    const pidsToKill = new Set<number>();
    const tryReadPids = (filePath: string, keys: string[]) => {
      try {
        if (fs.existsSync(filePath)) {
          const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
          for (const k of keys) {
            if (typeof content[k] === "number" && content[k] > 0 && content[k] !== process.pid) {
              pidsToKill.add(content[k]);
            }
          }
          if (Array.isArray(content.workers)) {
            for (const w of content.workers) {
              if (typeof w?.pid === "number" && w.pid > 0 && w.pid !== process.pid) {
                pidsToKill.add(w.pid);
              }
            }
          }
        }
      } catch {}
    };

    tryReadPids(guardianFile, ["pid"]);
    tryReadPids(checkpointFile, ["activePid"]);
    tryReadPids(supervisorFile, ["supervisorPid"]);
    tryReadPids(serverInfoFile, ["pid"]);
    tryReadPids(globalServerInfo, ["pid"]);

    const { execa } = await import("execa");
    const stoppedPids: number[] = [];

    for (const pid of pidsToKill) {
      try {
        if (process.platform === "win32") {
          await execa("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(pid, "SIGKILL");
        }
        stoppedPids.push(pid);
      } catch {}
    }

    // Clean up registration files so port is marked quiescent
    for (const f of [guardianFile, supervisorFile, checkpointFile, serverInfoFile, globalServerInfo]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }

    steps.push({
      name: "Supervised Core API",
      ok: true,
      message: stoppedPids.length > 0
        ? `Core on port ${corePort} stopped (terminated PID(s): ${stoppedPids.join(", ")}). Port freed.`
        : `Port ${corePort}: Core was already inactive or stopped.`,
    });
  } catch (error) {
    steps.push({
      name: "Supervised Core API",
      ok: false,
      message: `Core stop error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // 7. Lingering Superagent Daemons & MCP Processes
  try {
    const { execa } = await import("execa");
    const stoppedDaemons: number[] = [];
    if (process.platform === "win32") {
      try {
        const psScript = `
          Get-CimInstance Win32_Process | Where-Object {
            ($_.Name -like 'bun*' -or $_.Name -like 'node*') -and
            ($_.CommandLine -like '*--mcp*' -or
             $_.CommandLine -like '*senopati*' -or
             $_.CommandLine -like '*core boot*' -or
             $_.CommandLine -like '*core start*' -or
             $_.CommandLine -like '*--server*')
          } | ForEach-Object { $_.ProcessId }
        `;
        const res = await execa("powershell", ["-NoProfile", "-Command", psScript]);
        const lines = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        for (const line of lines) {
          const pid = parseInt(line, 10);
          if (pid && pid !== process.pid && pid !== process.ppid) {
            try {
              await execa("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
              stoppedDaemons.push(pid);
            } catch {}
          }
        }
      } catch {}
    }

    steps.push({
      name: "Superagent Background Daemons",
      ok: true,
      message: stoppedDaemons.length > 0
        ? `Terminated ${stoppedDaemons.length} lingering daemon/MCP process(es): ${stoppedDaemons.join(", ")}.`
        : "No lingering background daemons or MCP processes found.",
    });
  } catch (error) {
    steps.push({
      name: "Superagent Background Daemons",
      ok: false,
      message: `Failed to terminate background daemons: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // 8. Cleanup Lingering Cloudflare Child Processes (Windows / POSIX)
  try {
    const { execa } = await import("execa");
    if (process.platform === "win32") {
      try {
        await execa("taskkill", ["/F", "/IM", "cloudflared.exe"], { stdio: "ignore" });
        steps.push({
          name: "Cloudflare Daemon Processes",
          ok: true,
          message: "Terminated lingering cloudflared processes.",
        });
      } catch {
        // Not running or already exited
        steps.push({
          name: "Cloudflare Daemon Processes",
          ok: true,
          message: "No lingering cloudflared processes found.",
        });
      }
    }
  } catch {}

  const allOk = steps.every((s) => s.ok);
  return {
    ok: allOk,
    timestamp: Date.now(),
    steps,
  };
}

/**
 * CLI Runner for 'superagent drain all' or 'superagent stop all'.
 */
export async function runUnifiedDrainCli(args: string[] = []): Promise<void> {
  const portIdx = args.indexOf("--port");
  const corePort = portIdx !== -1 && args[portIdx + 1] ? parseInt(args[portIdx + 1], 10) : 7888;

  console.log("═════════════════════════════════════════════════════════════════════════════");
  console.log("  Superagent — Unified Drain All Services");
  console.log("  Gracefully draining background daemons, MCP servers, tunnels, and Core...");
  console.log("═════════════════════════════════════════════════════════════════════════════");

  const report = await drainAllServices({ corePort });

  for (const step of report.steps) {
    const icon = step.ok ? "✓" : "✗";
    console.log(`  [${icon}] ${step.name.padEnd(28)}: ${step.message}`);
  }

  console.log("═════════════════════════════════════════════════════════════════════════════");
  if (report.ok) {
    console.log("  ✓ All background services and daemons have been successfully drained.");
  } else {
    console.log("  ! Drain finished with warnings on some services. Review the checklist above.");
  }
  console.log("═════════════════════════════════════════════════════════════════════════════");
}
