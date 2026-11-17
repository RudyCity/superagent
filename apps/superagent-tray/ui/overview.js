"use strict";

/**
 * System Overview Dashboard Controller for SuperAgent Tray.
 * Consolidates real-time telemetry, multi-subsystem topology,
 * KPI metrics, live event streams, and quick launch workflows.
 */

(function () {
  const $ = (id) => document.getElementById(id);

  const escapeHtml = (str) =>
    String(str ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));

  const timeFormat = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const dateTimeFormat = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const overviewState = {
    loading: false,
    lastRefresh: null,
    coreOnline: false,
    corePort: null,
    corePid: null,
    coreVersion: null,
    daemonRunning: false,
    jobsTotal: 0,
    jobsActive: 0,
    nextRun: null,
    delegateTabs: 0,
    delegateClients: 0,
    delegatePaired: false,
    terminalTasks: 0,
    lanDevices: 0,
    lanActive: 0,
    securityApproved: 0,
    securityRules: 0,
    securityPolicyMode: "deny",
    trustedTargets: 0,
    mcpServers: 0,
    trayVersion: null,
    trayBuildNumber: null,
    activities: [],
    telemetryUnavailable: [],
    runtimeObserved: false,
    securityObserved: false,
  };

  const overviewInvoke = async (action, payload) => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return null;
    try {
      return await invoke(action, payload ?? {});
    } catch (err) {
      // Return null on failure; fail closed without leaking internals
      return null;
    }
  };

  function formatRelativeTime(timestamp) {
    if (!timestamp) return "-";
    const deltaMs = Date.now() - timestamp;
    if (deltaMs < 5000) return "Just now";
    if (deltaMs < 60000) return `${Math.floor(deltaMs / 1000)}s ago`;
    if (deltaMs < 3600000) return `${Math.floor(deltaMs / 60000)}m ago`;
    if (deltaMs < 86400000) return `${Math.floor(deltaMs / 3600000)}h ago`;
    return dateTimeFormat.format(new Date(timestamp));
  }

  /* --------------------------------------------------------------------------
     Data Fetching
     -------------------------------------------------------------------------- */
  async function fetchOverviewTelemetry() {
    if (overviewState.loading) return;
    overviewState.loading = true;
    overviewState.coreOnline = false;
    overviewState.runtimeObserved = false;
    overviewState.securityObserved = false;
    overviewState.corePid = null;
    overviewState.coreVersion = null;
    overviewState.trayVersion = null;
    overviewState.trayBuildNumber = null;
    overviewState.delegateTabs = 0;
    overviewState.delegateClients = 0;
    overviewState.delegatePaired = false;
    overviewState.terminalTasks = 0;
    overviewState.jobsTotal = 0;
    overviewState.jobsActive = 0;
    overviewState.nextRun = null;
    overviewState.securityRules = 0;
    overviewState.securityApproved = 0;
    overviewState.trustedTargets = 0;
    overviewState.lanDevices = 0;
    overviewState.lanActive = 0;
    overviewState.telemetryUnavailable = [];

    const refreshBtn = $("overview-refresh-btn");
    if (refreshBtn) refreshBtn.classList.add("loading");

    try {
      const [
        runtimeSnap,
        daemonJobs,
        daemonRuns,
        delegateStatus,
        terminalTasks,
        connectionLogs,
        trayVersion,
        trayBuild,
        lanSnap,
        permanentAccessSnap,
        inputPolicySnap,
        accessAuditSnap,
      ] = await Promise.allSettled([
        overviewInvoke("detect_runtime"),
        overviewInvoke("daemon_action", { action: "list", payload: null }),
        overviewInvoke("daemon_action", { action: "runs", payload: null }),
        overviewInvoke("get_delegate_status"),
        overviewInvoke("get_terminal_tasks"),
        overviewInvoke("get_connection_logs", { limit: 12 }),
        overviewInvoke("get_tray_version"),
        overviewInvoke("get_tray_build_number"),
        overviewInvoke("lan_support_action", { action: "list", payload: {} }),
        overviewInvoke("get_permanent_access_registry"),
        overviewInvoke("get_desktop_input_policy"),
        overviewInvoke("get_permanent_access_audit_log", { limit: 6 }),
      ]);

      const telemetrySources = ["runtime", "scheduler jobs", "scheduler runs", "delegate",
        "terminal", "connection logs", "tray version", "tray build", "LAN devices",
        "access registry", "desktop policy", "access audit"];
      const telemetryResults = [runtimeSnap, daemonJobs, daemonRuns, delegateStatus,
        terminalTasks, connectionLogs, trayVersion, trayBuild, lanSnap,
        permanentAccessSnap, inputPolicySnap, accessAuditSnap];
      overviewState.telemetryUnavailable = telemetrySources.filter((name, i) =>
        telemetryResults[i].status !== "fulfilled" || telemetryResults[i].value == null);

      // 1. Process Runtime Snapshot
      if (runtimeSnap.status === "fulfilled" && runtimeSnap.value) {
        const snap = runtimeSnap.value;
        overviewState.runtimeObserved = true;
        const selectedPort = snap.selectedCorePort || window.__SUPERAGENT_CORE_PORT || 7888;
        overviewState.corePort = selectedPort;

        const activeCore = (snap.cores || []).find((c) => c.port === selectedPort || c.selected);
        if (activeCore) {
          overviewState.coreOnline = activeCore.state === "online";
          overviewState.corePid = activeCore.pid || null;
          overviewState.coreVersion = activeCore.version || null;
          overviewState.daemonRunning = Boolean(activeCore.daemon?.running);
          overviewState.mcpServers = activeCore.services?.mcp?.serverCount || 0;
        } else {
          overviewState.coreOnline = false; // No selected verified Core; never adopt another owner.
        }
      } else {
        // Fallback to global state
        overviewState.corePort = window.__SUPERAGENT_CORE_PORT || 7888;
      }

      // 2. Process Daemon Jobs
      if (daemonJobs.status === "fulfilled" && Array.isArray(daemonJobs.value?.jobs || daemonJobs.value)) {
        const jobs = daemonJobs.value.jobs || daemonJobs.value;
        overviewState.jobsTotal = jobs.length;
        overviewState.jobsActive = jobs.filter((j) => j.enabled).length;

        const next = jobs
          .filter((j) => j.enabled && j.nextRun > Date.now())
          .sort((a, b) => a.nextRun - b.nextRun)[0];
        overviewState.nextRun = next ? next.nextRun : null;
      }

      // 3. Process Chrome Delegate
      if (delegateStatus.status === "fulfilled" && delegateStatus.value) {
        const ds = delegateStatus.value;
        overviewState.delegateTabs = ds.activeTabsCount || ds.tabs?.length || 0;
        overviewState.delegateClients = ds.connectedClientsCount || ds.clients?.length || 0;
        overviewState.delegatePaired = Boolean(ds.paired || overviewState.delegateClients > 0);
      }

      // 4. Process Terminal Tasks
      if (terminalTasks.status === "fulfilled" && Array.isArray(terminalTasks.value)) {
        overviewState.terminalTasks = terminalTasks.value.filter((t) => t.status === "running").length;
      }

      // 5. Process Tray Info
      if (trayVersion.status === "fulfilled" && trayVersion.value) {
        overviewState.trayVersion = String(trayVersion.value);
      }
      if (trayBuild.status === "fulfilled" && trayBuild.value) {
        overviewState.trayBuildNumber = String(trayBuild.value);
      }

      // 6. Process LAN Devices
      if (lanSnap.status === "fulfilled" && lanSnap.value) {
        const lanData = lanSnap.value;
        const devices = Array.isArray(lanData.devices) ? lanData.devices : [];
        const tunnelDevs = Array.isArray(lanData.tunnelDevices) ? lanData.tunnelDevices : [];
        const allDevices = [...devices, ...tunnelDevs];
        overviewState.lanDevices = allDevices.length;
        overviewState.lanActive = allDevices.filter((d) => Boolean(d.connected)).length;
      }

      // 7. Process Security & Permanent ACL
      if (permanentAccessSnap.status === "fulfilled" && permanentAccessSnap.value) {
        overviewState.securityObserved = true;
        const reg = permanentAccessSnap.value;
        const rules = Array.isArray(reg.rules) ? reg.rules : [];
        overviewState.securityRules = rules.length;
        overviewState.securityApproved = rules.filter((r) => r.effect === "allow").length;
      }
      if (inputPolicySnap.status === "fulfilled" && inputPolicySnap.value) {
        const pol = inputPolicySnap.value;
        overviewState.securityPolicyMode = pol.mode || "trusted";
        overviewState.trustedTargets = Array.isArray(pol.targets) ? pol.targets.length : 0;
      }

      // 8. Assemble Activities (Logs + Scheduler Runs + Access Audits)
      const acts = [];

      const recordedRuns = daemonRuns.value?.runs || daemonRuns.value;
      if (daemonRuns.status === "fulfilled" && Array.isArray(recordedRuns)) {
        for (const run of recordedRuns.slice(0, 5)) {
          acts.push({
            id: `run-${run.id || run.startedAt}`,
            timestamp: run.completedAt || run.startedAt,
            tag: "cron",
            tagLabel: "CRON",
            title: run.jobName || `Job ${run.jobId || "Run"}`,
            subtitle: run.status === "success" ? "Execution succeeded" : `Status: ${run.status}`,
            status: run.status === "success" ? "success" : run.status === "error" ? "error" : "info",
          });
        }
      }

      if (accessAuditSnap.status === "fulfilled" && Array.isArray(accessAuditSnap.value)) {
        for (const audit of accessAuditSnap.value.slice(0, 4)) {
          const isAllowed = audit.effect === "allow";
          acts.push({
            id: `audit-${audit.id || audit.timestamp}`,
            timestamp: audit.timestamp,
            tag: "security",
            tagLabel: "SECURITY",
            title: `${audit.application || "Desktop App"}: ${audit.operation || "access"} (${audit.effect || "checked"})`,
            subtitle: audit.target || audit.executablePath || "",
            status: isAllowed ? "success" : "error",
          });
        }
      }

      if (connectionLogs.status === "fulfilled" && Array.isArray(connectionLogs.value?.items)) {
        for (const item of connectionLogs.value.items.slice(0, 7)) {
          let tag = "core";
          if (item.source === "delegate") tag = "delegate";
          else if (item.source === "mcp") tag = "mcp";
          else if (item.source === "terminal") tag = "terminal";
          else if (item.source === "lan") tag = "lan";
          else if (item.source === "security" || item.source === "access") tag = "security";

          acts.push({
            id: item.id,
            timestamp: item.timestamp,
            tag,
            tagLabel: (item.sourceLabel || tag).slice(0, 8).toUpperCase(),
            title: item.detail || item.event || "Connection event",
            subtitle: item.endpoint ? `${item.direction === "in" ? "← " : "→ "}${item.endpoint}` : "",
            status: item.status || "info",
          });
        }
      }

      // Sort activities descending by timestamp
      overviewState.activities = acts
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, 8);

      overviewState.lastRefresh = Date.now();
      renderOverview();
    } finally {
      overviewState.loading = false;
      if (refreshBtn) refreshBtn.classList.remove("loading");
    }
  }

  /* --------------------------------------------------------------------------
     Rendering
     -------------------------------------------------------------------------- */
  function renderOverview() {
    renderHeroRibbon();
    renderKpis();
    renderServicesGrid();
    renderActivityFeed();
    renderMetaStrip();
  }

  function renderHeroRibbon() {
    const beacon = $("overview-beacon-dot");
    const statusText = $("overview-core-status-text");
    const portPill = $("overview-port-pill");
    const pidPill = $("overview-pid-pill");
    const verPill = $("overview-version-pill");
    const summary = $("overview-healthy-summary");
    const syncTime = $("overview-last-sync");

    const isOnline = overviewState.coreOnline;
    const isPartial = overviewState.telemetryUnavailable.length > 0;

    if (beacon) {
      beacon.className = "overview-beacon-dot";
      if (!overviewState.runtimeObserved || !isOnline) beacon.classList.add("offline");
      else if (isPartial) beacon.classList.add("degraded");
    }

    if (statusText) {
      statusText.textContent = !overviewState.runtimeObserved ? "Core Status Unavailable" :
        isOnline ? "Core Online & Operating" : "Core Offline / Standalone";
    }

    if (portPill) {
      portPill.textContent = `:${overviewState.corePort || 7888} LOOPBACK`;
      portPill.className = `overview-pill ${isOnline ? "success" : "accent"}`;
    }

    if (pidPill) {
      pidPill.textContent = overviewState.corePid ? `PID ${overviewState.corePid}` : "IPC READY";
    }

    if (verPill) {
      const ver = overviewState.coreVersion;
      verPill.textContent = ver ? (ver.startsWith("v") ? ver : `v${ver}`) : "Version unverified";
    }

    if (summary) {
      if (isOnline) {
        const issues = [];
        if (isPartial) issues.push(`${overviewState.telemetryUnavailable.length} telemetry sources unavailable`);
        if (!overviewState.delegatePaired) issues.push("Delegate Standby");
        if (overviewState.lanActive > 0) issues.push(`${overviewState.lanActive} LAN Active`);
        summary.textContent = issues.length ? `Core Active · ${issues.join(" · ")}` : "All Primary Subsystems Operational";
      } else {
        summary.textContent = overviewState.runtimeObserved ? "Companion Running · Core Offline" :
          "Runtime status unavailable · retry diagnostics";
      }
    }

    if (syncTime && overviewState.lastRefresh) {
      syncTime.textContent = `Updated ${timeFormat.format(new Date(overviewState.lastRefresh))}`;
    }
  }

  function renderKpis() {
    // 1. Core Server
    const kpiCoreVal = $("kpi-core-state");
    const kpiCoreMeta = $("kpi-core-meta");
    const kpiCoreBadge = $("kpi-core-badge");
    if (kpiCoreVal) kpiCoreVal.textContent = !overviewState.runtimeObserved ? "Unknown" : overviewState.coreOnline ? "Online" : "Offline";
    if (kpiCoreMeta) kpiCoreMeta.textContent = `Port :${overviewState.corePort || 7888} Loopback`;
    if (kpiCoreBadge) {
      kpiCoreBadge.textContent = overviewState.coreOnline ? "Live" : "Inactive";
      kpiCoreBadge.className = `stat-chip ${overviewState.coreOnline ? "success" : "danger"}`;
    }

    // 2. Schedulers
    const kpiJobsVal = $("kpi-jobs-count");
    const kpiJobsNext = $("kpi-jobs-next");
    if (kpiJobsVal) kpiJobsVal.textContent = `${overviewState.jobsActive} / ${overviewState.jobsTotal}`;
    if (kpiJobsNext) {
      kpiJobsNext.textContent = overviewState.nextRun
        ? `Next: ${dateTimeFormat.format(new Date(overviewState.nextRun))}`
        : "No upcoming triggers";
    }

    // 3. Delegate Tabs
    const kpiDelVal = $("kpi-delegate-tabs");
    const kpiDelMeta = $("kpi-delegate-meta");
    const kpiDelBadge = $("kpi-delegate-badge");
    if (kpiDelVal) kpiDelVal.textContent = `${overviewState.delegateTabs} Tabs`;
    if (kpiDelMeta) {
      kpiDelMeta.textContent = overviewState.delegatePaired ? "Extension Paired (:17341)" : "Awaiting Pairing";
    }
    if (kpiDelBadge) {
      kpiDelBadge.textContent = overviewState.delegatePaired ? "Paired" : "Standby";
      kpiDelBadge.className = `stat-chip ${overviewState.delegatePaired ? "success" : "accent"}`;
    }

    // 4. Terminal Tasks
    const kpiTermVal = $("kpi-terminal-tasks");
    const kpiTermMeta = $("kpi-terminal-meta");
    if (kpiTermVal) kpiTermVal.textContent = `${overviewState.terminalTasks} Running`;
    if (kpiTermMeta) kpiTermMeta.textContent = "Background Subprocesses";

    // 5. LAN Devices
    const kpiLanVal = $("kpi-lan-devices");
    const kpiLanMeta = $("kpi-lan-meta");
    const kpiLanBadge = $("kpi-lan-badge");
    if (kpiLanVal) {
      kpiLanVal.textContent = `${overviewState.lanDevices} Paired`;
    }
    if (kpiLanMeta) {
      if (overviewState.lanActive > 0) {
        kpiLanMeta.textContent = `${overviewState.lanActive} active session${overviewState.lanActive > 1 ? "s" : ""}`;
      } else if (overviewState.lanDevices > 0) {
        kpiLanMeta.textContent = "Local Peer Network";
      } else {
        kpiLanMeta.textContent = "No peers paired";
      }
    }
    if (kpiLanBadge) {
      if (overviewState.lanActive > 0) {
        kpiLanBadge.textContent = "Active";
        kpiLanBadge.className = "stat-chip success";
      } else if (overviewState.lanDevices > 0) {
        kpiLanBadge.textContent = "Paired";
        kpiLanBadge.className = "stat-chip accent";
      } else {
        kpiLanBadge.textContent = "P2P";
        kpiLanBadge.className = "stat-chip";
      }
    }

    // 6. Security
    const kpiSecVal = $("kpi-security-status");
    const kpiSecMeta = $("kpi-security-meta");
    const kpiSecBadge = $("kpi-security-badge");
    if (kpiSecVal) {
      if (!overviewState.securityObserved) {
        kpiSecVal.textContent = "Unverified";
      } else if (overviewState.securityRules > 0) {
        kpiSecVal.textContent = `${overviewState.securityRules} Rules`;
      } else {
        kpiSecVal.textContent = overviewState.securityObserved ? "Default Deny" : "Unverified";
      }
    }
    if (kpiSecMeta) {
      if (!overviewState.securityObserved) {
        kpiSecMeta.textContent = "ACL unavailable · review Security Approval";
      } else if (overviewState.trustedTargets > 0) {
        kpiSecMeta.textContent = `${overviewState.trustedTargets} active target${overviewState.trustedTargets > 1 ? "s" : ""} · Permanent ACL`;
      } else if (overviewState.securityRules > 0) {
        kpiSecMeta.textContent = `${overviewState.securityApproved} allowed · Permanent ACL`;
      } else {
        kpiSecMeta.textContent = "Default Deny · Permanent ACL";
      }
    }
    if (kpiSecBadge) {
      kpiSecBadge.textContent = overviewState.securityObserved ? "Configured" : "Unverified";
      kpiSecBadge.className = `stat-chip ${overviewState.securityObserved ? "accent" : ""}`;
    }
  }

  function renderServicesGrid() {
    const isOnline = overviewState.coreOnline;

    // Core
    const corePill = $("srv-core-pill");
    const coreMeta = $("srv-core-meta");
    if (corePill) {
      corePill.textContent = isOnline ? "Active" : "Offline";
      corePill.className = `overview-service-status-pill ${isOnline ? "online" : "offline"}`;
    }
    if (coreMeta) {
      coreMeta.textContent = isOnline ? `Port :${overviewState.corePort || 7888}` : "No OS process";
    }

    // Schedulers
    const schedPill = $("srv-sched-pill");
    const schedMeta = $("srv-sched-meta");
    if (schedPill) {
      schedPill.textContent = overviewState.jobsActive > 0 ? "Running" : "Idle";
      schedPill.className = `overview-service-status-pill ${overviewState.jobsActive > 0 ? "online" : "standby"}`;
    }
    if (schedMeta) {
      schedMeta.textContent = `${overviewState.jobsTotal} total schedules`;
    }

    // Delegate
    const delPill = $("srv-delegate-pill");
    const delMeta = $("srv-delegate-meta");
    if (delPill) {
      delPill.textContent = overviewState.delegatePaired ? "Paired" : "Standby";
      delPill.className = `overview-service-status-pill ${overviewState.delegatePaired ? "online" : "standby"}`;
    }
    if (delMeta) {
      delMeta.textContent = `${overviewState.delegateTabs} active browser tabs`;
    }

    // Terminal
    const termPill = $("srv-terminal-pill");
    const termMeta = $("srv-terminal-meta");
    if (termPill) {
      termPill.textContent = overviewState.terminalTasks > 0 ? "Active" : "Ready";
      termPill.className = `overview-service-status-pill ${overviewState.terminalTasks > 0 ? "online" : "standby"}`;
    }
    if (termMeta) {
      termMeta.textContent = `${overviewState.terminalTasks} running tasks`;
    }
  }

  function renderActivityFeed() {
    const list = $("overview-activity-list");
    if (!list) return;

    if (!overviewState.activities.length) {
      list.innerHTML = `
        <li class="overview-activity-item empty-state">
          <div class="overview-activity-info">
            <span class="overview-activity-title" style="color: var(--text-muted);">No recent connection logs or execution events recorded yet.</span>
          </div>
        </li>
      `;
      return;
    }

    list.innerHTML = overviewState.activities
      .map(
        (act) => `
        <li class="overview-activity-item" data-id="${escapeHtml(act.id)}">
          <div class="overview-activity-left">
            <span class="overview-activity-tag ${escapeHtml(act.tag)}">${escapeHtml(act.tagLabel)}</span>
            <div class="overview-activity-info">
              <span class="overview-activity-title" title="${escapeHtml(act.title)}">${escapeHtml(act.title)}</span>
              ${act.subtitle ? `<span class="overview-activity-sub">${escapeHtml(act.subtitle)}</span>` : ""}
            </div>
          </div>
          <div class="overview-activity-right">
            <span class="status-badge status-${escapeHtml(act.status)}">${escapeHtml(act.status)}</span>
            <span class="overview-activity-time">${escapeHtml(formatRelativeTime(act.timestamp))}</span>
          </div>
        </li>
      `
      )
      .join("");
  }

  function renderMetaStrip() {
    const appVer = $("overview-tray-version");
    const appBuild = $("overview-tray-build");
    const coreTarget = $("overview-core-target");

    if (appVer) {
      appVer.textContent = overviewState.trayVersion || "Unverified";
    }
    if (appBuild) {
      appBuild.textContent = overviewState.trayBuildNumber || "Unverified";
    }
    if (coreTarget) {
      coreTarget.textContent = `127.0.0.1:${overviewState.corePort || 7888}`;
    }
  }

  /* --------------------------------------------------------------------------
     Interaction & Navigation Handlers
     -------------------------------------------------------------------------- */
  function wireEventListeners() {
    // Top Refresh Button
    const refreshBtn = $("overview-refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", (e) => {
        e.preventDefault();
        fetchOverviewTelemetry();
      });
    }

    // Interactive Jump Links
    document.querySelectorAll("[data-jump-page]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const target = el.getAttribute("data-jump-page");
        if (target && typeof window.navigateToPage === "function") {
          window.navigateToPage(target);
        }
      });
    });

    // Quick Actions
    const btnNewSchedule = $("overview-action-new-schedule");
    if (btnNewSchedule) {
      btnNewSchedule.addEventListener("click", () => {
        if (typeof window.navigateToPage === "function") {
          window.navigateToPage("jobs");
          const newBtn = $("new-btn");
          if (newBtn) {
            if (typeof window.setTimeout === "function") {
              window.setTimeout(() => newBtn.click(), 100);
            } else {
              newBtn.click();
            }
          }
        }
      });
    }

    const btnScanRuntime = $("overview-action-scan-runtime");
    if (btnScanRuntime) {
      btnScanRuntime.addEventListener("click", () => {
        if (typeof window.navigateToPage === "function") {
          window.navigateToPage("runtime");
          const scanBtn = $("runtime-refresh");
          if (scanBtn) {
            if (typeof window.setTimeout === "function") {
              window.setTimeout(() => scanBtn.click(), 100);
            } else {
              scanBtn.click();
            }
          }
        }
      });
    }

    const btnRestartCore = $("overview-action-restart-core");
    if (btnRestartCore) {
      btnRestartCore.addEventListener("click", async () => {
        const port = overviewState.corePort || 7888;
        if (typeof window.confirm === "function" && !window.confirm(`Are you sure you want to gracefully restart SuperAgent Core on port ${port}?`)) {
          return;
        }
        window.TrayFeedback?.notify({
          kind: "info",
          message: `Restarting Core on port ${port}...`,
          scope: "overview",
        });
        window.TrayFeedback?.notify({kind:"warning",scope:"overview",
          message:"Legacy unbound restart disabled. Use the owner-bound plan in Operational Readiness."});
        document.getElementById("op-lifecycle-service")?.focus?.();
      });
    }
  }

  /* --------------------------------------------------------------------------
     Initialization
     -------------------------------------------------------------------------- */
  let refreshTimer = null;
  function schedulePolling() {
    if (refreshTimer && typeof window.clearInterval === "function") {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (typeof window.setInterval === "function") {
      refreshTimer = window.setInterval(() => {
        const pageOverview = $("page-overview");
        if (pageOverview && !pageOverview.hidden && pageOverview.classList.contains("active")) {
          fetchOverviewTelemetry();
        }
      }, 15000);
    }
  }

  window.__superagentOverviewRefresh = fetchOverviewTelemetry;
  window.__superagentOverviewState = overviewState;

  window.addEventListener("superagent-core-selected", () => {
    fetchOverviewTelemetry();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      wireEventListeners();
      fetchOverviewTelemetry();
      schedulePolling();
    });
  } else {
    wireEventListeners();
    fetchOverviewTelemetry();
    schedulePolling();
  }
})();
