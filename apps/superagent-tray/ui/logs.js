"use strict";

/**
 * Connection Logs Controller for SuperAgent Tray.
 * Provides real-time telemetry inspection, multi-source log aggregation,
 * full-text search, multi-field filtering, column sorting, pagination,
 * and JSON inspection modal.
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const notifyLogs = (kind, message) => window.TrayFeedback?.notify({
    kind, message, scope: "logs",
  });

  const logsState = {
    items: [],
    totalCount: 0,
    page: 1,
    pageSize: 25,
    totalPages: 1,
    search: "",
    source: "all",
    direction: "all",
    status: "all",
    timeRange: "all",
    sortBy: "timestamp",
    sortOrder: "desc",
    autoRefresh: false,
    autoRefreshTimer: null,
    loading: false,
    selectedLog: null,
  };

  const escapeHtml = (str) =>
    String(str ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));

  const timeFormat = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  });

  function formatTime(ms) {
    if (!ms) return "-";
    try {
      return timeFormat.format(new Date(ms));
    } catch {
      return String(ms);
    }
  }

  function formatDuration(ms) {
    if (ms === undefined || ms === null) return "-";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  async function fetchLogs(manual = false) {
    if (logsState.loading) return;
    logsState.loading = true;

    const refreshBtn = $("logs-refresh-btn");
    const ticket = manual === true ? window.TrayFeedback?.begin({
      key:"logs:refresh",button:refreshBtn,label:"Refreshing logs…",
    }) : null;
    if (refreshBtn) refreshBtn.disabled = true;

    const query = {
      page: logsState.page,
      pageSize: logsState.pageSize,
      search: logsState.search.trim() || undefined,
      source: logsState.source !== "all" ? logsState.source : undefined,
      direction: logsState.direction !== "all" ? logsState.direction : undefined,
      status: logsState.status !== "all" ? logsState.status : undefined,
      timeRange: logsState.timeRange !== "all" ? logsState.timeRange : undefined,
      sortBy: logsState.sortBy,
      sortOrder: logsState.sortOrder,
    };

    try {
      let data = null;
      const invoke = window.__TAURI__?.core?.invoke;
      if (typeof invoke === "function") {
        data = await invoke("get_connection_logs", { query });
      } else {
        // Fallback to authenticated Core server loopback REST endpoint
        const res = await fetch("/api/desktop/connection-logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(query),
        });
        if (res.ok) {
          data = await res.json();
        }
      }

      if (data) {
        logsState.items = data.items || [];
        logsState.totalCount = data.totalCount || 0;
        logsState.page = data.page || 1;
        logsState.pageSize = data.pageSize || 25;
        logsState.totalPages = data.totalPages || 1;

        updateStats(data);
        renderTable();
        renderPagination();
      }
      if (manual === true) notifyLogs("info", "Connection logs refreshed.");
    } catch (err) {
      console.warn("[Logs] Failed to fetch connection logs:", err);
      const tbody = $("logs-tbody");
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state error">Cannot load connection logs. Check Core connectivity.</td></tr>';
      }
      if (manual === true) notifyLogs("error", "Connection logs unavailable.");
    } finally {
      logsState.loading = false;
      if (refreshBtn) refreshBtn.disabled = false;
      ticket?.end();
    }
  }

  function updateStats(data) {
    const totalEl = $("logs-stat-total");
    const inEl = $("logs-stat-in");
    const outEl = $("logs-stat-out");
    const errEl = $("logs-stat-err");

    if (totalEl) totalEl.textContent = String(data.totalCount || 0);

    const dirStats = data.directionStats || {};
    if (inEl) inEl.textContent = String(dirStats["in"] || 0);
    if (outEl) outEl.textContent = String(dirStats["out"] || 0);

    const statusStats = data.statusStats || {};
    const errCount = (statusStats["error"] || 0) + (statusStats["warn"] || 0);
    if (errEl) errEl.textContent = String(errCount);
  }

  function getDirectionBadge(dir) {
    if (dir === "in") {
      return '<span class="dir-badge dir-in" title="Inbound Traffic (Masuk)"><span class="dir-arrow">↙</span> IN</span>';
    }
    if (dir === "out") {
      return '<span class="dir-badge dir-out" title="Outbound Traffic (Keluar)"><span class="dir-arrow">↗</span> OUT</span>';
    }
    return '<span class="dir-badge dir-event" title="Connection Lifecycle Event"><span class="dir-arrow">⚡</span> EVT</span>';
  }

  function getStatusBadge(status) {
    const s = String(status || "info").toLowerCase();
    const map = {
      success: { label: "Success", cls: "success" },
      info: { label: "Info", cls: "info" },
      warn: { label: "Warning", cls: "warn" },
      error: { label: "Error", cls: "error" },
    };
    const conf = map[s] || { label: s.toUpperCase(), cls: "info" };
    return `<span class="status-pill ${conf.cls}"><span class="pill-dot"></span>${conf.label}</span>`;
  }

  function getSourceBadge(source, label) {
    const s = String(source || "").toLowerCase();
    let cls = "source-default";
    if (s === "delegate") cls = "source-delegate";
    else if (s === "mcp") cls = "source-mcp";
    else if (s === "oauth") cls = "source-oauth";
    else if (s === "tunnel") cls = "source-tunnel";
    else if (s === "server") cls = "source-server";
    return `<span class="source-tag ${cls}">${escapeHtml(label || source)}</span>`;
  }

  function renderTable() {
    const tbody = $("logs-tbody");
    if (!tbody) return;

    if (!logsState.items.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No connection logs found matching your filters.</td></tr>`;
      return;
    }

    tbody.innerHTML = logsState.items
      .map((item, idx) => {
        return `<tr class="log-row" data-id="${escapeHtml(item.id)}" data-index="${idx}">
          <td class="log-time-cell">
            <span class="log-time">${escapeHtml(formatTime(item.timestamp))}</span>
            <small class="log-time-iso" title="${escapeHtml(item.timestampIso)}">${escapeHtml(item.timestampIso.slice(11, 23))}</small>
          </td>
          <td>${getDirectionBadge(item.direction)}</td>
          <td>${getSourceBadge(item.source, item.sourceLabel)}</td>
          <td>
            <div class="log-event-cell">
              <strong class="log-event-name">${escapeHtml(item.event)}</strong>
              <small class="log-detail-snippet" title="${escapeHtml(item.detail)}">${escapeHtml(item.detail)}</small>
            </div>
          </td>
          <td>
            <code class="log-endpoint" title="${escapeHtml(item.endpoint)}">${escapeHtml(item.endpoint)}</code>
          </td>
          <td>${getStatusBadge(item.status)}</td>
          <td>
            <span class="log-duration">${formatDuration(item.durationMs)}</span>
          </td>
          <td class="text-right">
            <button type="button" class="button ghost sm inspect-btn" data-index="${idx}" title="Inspect full connection metadata">Inspect</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  function renderPagination() {
    const start = logsState.totalCount === 0 ? 0 : (logsState.page - 1) * logsState.pageSize + 1;
    const end = Math.min(logsState.page * logsState.pageSize, logsState.totalCount);

    const infoEl = $("logs-page-info");
    if (infoEl) {
      infoEl.textContent = `Showing ${start}–${end} of ${logsState.totalCount} logs`;
    }

    const curEl = $("logs-page-current");
    if (curEl) {
      curEl.textContent = `Page ${logsState.page} of ${logsState.totalPages}`;
    }

    const firstBtn = $("logs-page-first");
    const prevBtn = $("logs-page-prev");
    const nextBtn = $("logs-page-next");
    const lastBtn = $("logs-page-last");

    if (firstBtn) firstBtn.disabled = logsState.page <= 1;
    if (prevBtn) prevBtn.disabled = logsState.page <= 1;
    if (nextBtn) nextBtn.disabled = logsState.page >= logsState.totalPages;
    if (lastBtn) lastBtn.disabled = logsState.page >= logsState.totalPages;

    // Update sort headers indicators
    document.querySelectorAll(".sortable-th").forEach((th) => {
      const field = th.dataset.sort;
      const icon = th.querySelector(".sort-icon");
      if (icon) {
        if (field === logsState.sortBy) {
          icon.textContent = logsState.sortOrder === "asc" ? "▲" : "▼";
          th.classList.add("sorted");
        } else {
          icon.textContent = "";
          th.classList.remove("sorted");
        }
      }
    });

    const orderIndicator = $("logs-sort-order-indicator");
    if (orderIndicator) {
      orderIndicator.textContent = logsState.sortOrder === "asc" ? "▲ ASC" : "▼ DESC";
    }
  }

  function openDetailModal(item) {
    if (!item) return;
    logsState.selectedLog = item;

    const modal = $("log-detail-dialog");
    if (!modal) return;

    $("log-detail-ts").textContent = `${formatTime(item.timestamp)} (${item.timestampIso})`;
    $("log-detail-dir").innerHTML = getDirectionBadge(item.direction);
    $("log-detail-source").innerHTML = getSourceBadge(item.source, item.sourceLabel);
    $("log-detail-status").innerHTML = getStatusBadge(item.status);
    $("log-detail-endpoint").textContent = item.endpoint;
    $("log-detail-summary").textContent = item.detail;

    let jsonFormatted = "";
    if (item.rawJson) {
      try {
        jsonFormatted = JSON.stringify(JSON.parse(item.rawJson), null, 2);
      } catch {
        jsonFormatted = item.rawJson;
      }
    } else {
      jsonFormatted = JSON.stringify(item, null, 2);
    }
    $("log-detail-json").textContent = jsonFormatted;

    modal.hidden = false;
  }

  function closeDetailModal() {
    const modal = $("log-detail-dialog");
    if (modal) modal.hidden = true;
    logsState.selectedLog = null;
  }

  function exportCurrentLogs() {
    if (!logsState.items.length) {
      notifyLogs("warning", "No connection logs in the current view to export.");
      return;
    }
    const jsonStr = JSON.stringify(logsState.items, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `superagent-connection-logs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notifyLogs("info", "Log JSON export prepared. Check the destination.");
  }

  function setupEventListeners() {
    // Search with debounce
    let searchDebounce;
    const searchInput = $("logs-search");
    const clearBtn = $("logs-search-clear");

    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        clearTimeout(searchDebounce);
        const val = e.target.value;
        if (clearBtn) clearBtn.hidden = !val;
        searchDebounce = setTimeout(() => {
          logsState.search = val;
          logsState.page = 1;
          fetchLogs();
        }, 250);
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        if (searchInput) searchInput.value = "";
        clearBtn.hidden = true;
        logsState.search = "";
        logsState.page = 1;
        fetchLogs();
      });
    }

    // Dropdown filters
    $("logs-filter-source")?.addEventListener("change", (e) => {
      logsState.source = e.target.value;
      logsState.page = 1;
      fetchLogs();
    });

    $("logs-filter-direction")?.addEventListener("change", (e) => {
      logsState.direction = e.target.value;
      logsState.page = 1;
      fetchLogs();
    });

    $("logs-filter-status")?.addEventListener("change", (e) => {
      logsState.status = e.target.value;
      logsState.page = 1;
      fetchLogs();
    });

    $("logs-filter-time")?.addEventListener("change", (e) => {
      logsState.timeRange = e.target.value;
      logsState.page = 1;
      fetchLogs();
    });

    $("logs-sort-by")?.addEventListener("change", (e) => {
      logsState.sortBy = e.target.value;
      logsState.page = 1;
      fetchLogs();
    });

    $("logs-sort-order-btn")?.addEventListener("click", () => {
      logsState.sortOrder = logsState.sortOrder === "asc" ? "desc" : "asc";
      logsState.page = 1;
      fetchLogs();
    });

    // Reset filters
    $("logs-clear-filters")?.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      if (clearBtn) clearBtn.hidden = true;
      if ($("logs-filter-source")) $("logs-filter-source").value = "all";
      if ($("logs-filter-direction")) $("logs-filter-direction").value = "all";
      if ($("logs-filter-status")) $("logs-filter-status").value = "all";
      if ($("logs-filter-time")) $("logs-filter-time").value = "all";
      if ($("logs-sort-by")) $("logs-sort-by").value = "timestamp";

      logsState.search = "";
      logsState.source = "all";
      logsState.direction = "all";
      logsState.status = "all";
      logsState.timeRange = "all";
      logsState.sortBy = "timestamp";
      logsState.sortOrder = "desc";
      logsState.page = 1;
      fetchLogs();
    });

    // Pagination buttons
    $("logs-page-first")?.addEventListener("click", () => {
      if (logsState.page > 1) {
        logsState.page = 1;
        fetchLogs();
      }
    });

    $("logs-page-prev")?.addEventListener("click", () => {
      if (logsState.page > 1) {
        logsState.page--;
        fetchLogs();
      }
    });

    $("logs-page-next")?.addEventListener("click", () => {
      if (logsState.page < logsState.totalPages) {
        logsState.page++;
        fetchLogs();
      }
    });

    $("logs-page-last")?.addEventListener("click", () => {
      if (logsState.page < logsState.totalPages) {
        logsState.page = logsState.totalPages;
        fetchLogs();
      }
    });

    $("logs-page-size")?.addEventListener("change", (e) => {
      logsState.pageSize = Number(e.target.value) || 25;
      logsState.page = 1;
      fetchLogs();
    });

    // Sortable column headers
    document.querySelectorAll(".sortable-th").forEach((th) => {
      th.addEventListener("click", () => {
        const field = th.dataset.sort;
        if (!field) return;
        if (logsState.sortBy === field) {
          logsState.sortOrder = logsState.sortOrder === "asc" ? "desc" : "asc";
        } else {
          logsState.sortBy = field;
          logsState.sortOrder = "desc";
        }
        if ($("logs-sort-by")) $("logs-sort-by").value = logsState.sortBy;
        logsState.page = 1;
        fetchLogs();
      });
    });

    // Inspect buttons in table rows
    $("logs-tbody")?.addEventListener("click", (e) => {
      const inspectBtn = e.target.closest(".inspect-btn");
      if (inspectBtn) {
        const idx = Number(inspectBtn.dataset.index);
        if (!isNaN(idx) && logsState.items[idx]) {
          openDetailModal(logsState.items[idx]);
        }
      }
    });

    // Detail modal actions
    $("log-detail-close")?.addEventListener("click", closeDetailModal);
    $("log-detail-dismiss")?.addEventListener("click", closeDetailModal);
    $("log-detail-dialog")?.addEventListener("click", (e) => {
      if (e.target === $("log-detail-dialog")) closeDetailModal();
    });

    $("log-detail-copy")?.addEventListener("click", async () => {
      const jsonEl = $("log-detail-json");
      if (jsonEl?.textContent) {
        try {
          await navigator.clipboard.writeText(jsonEl.textContent);
          const copyBtn = $("log-detail-copy");
          const origText = copyBtn.textContent;
          copyBtn.textContent = "Copied!";
          setTimeout(() => {
            copyBtn.textContent = origText;
          }, 2000);
          notifyLogs("success", "Connection log JSON copied.");
        } catch {
          notifyLogs("error", "Could not copy connection log JSON.");
        }
      }
    });

    // Top action bar buttons
    $("logs-refresh-btn")?.addEventListener("click", () => void fetchLogs(true));

    $("logs-autorefresh-btn")?.addEventListener("click", () => {
      logsState.autoRefresh = !logsState.autoRefresh;
      const textEl = $("logs-autorefresh-text");
      const btn = $("logs-autorefresh-btn");

      if (logsState.autoRefresh) {
        if (textEl) textEl.textContent = "Live Tail: ON";
        if (btn) btn.classList.add("active");
        logsState.autoRefreshTimer = setInterval(fetchLogs, 5000);
      } else {
        if (textEl) textEl.textContent = "Live Tail: Off";
        if (btn) btn.classList.remove("active");
        if (logsState.autoRefreshTimer) {
          clearInterval(logsState.autoRefreshTimer);
          logsState.autoRefreshTimer = null;
        }
      }
    });

    $("logs-export-btn")?.addEventListener("click", exportCurrentLogs);

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("log-detail-dialog") && !$("log-detail-dialog").hidden) {
        closeDetailModal();
      }
    });
  }

  window.__superagentLogsRefresh = fetchLogs;
  window.__superagentLogsState = logsState;

  // Initialize once DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setupEventListeners();
    });
  } else {
    setupEventListeners();
  }
})();
