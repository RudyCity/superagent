document.addEventListener("DOMContentLoaded", () => {
  const dotEl = document.getElementById("dot");
  const statusEl = document.getElementById("status-text");
  const connectBtn = document.getElementById("btn-connect");
  const healthPctEl = document.getElementById("advisor-health-pct");
  const gaugeFillEl = document.getElementById("advisor-gauge-fill");
  const countsEl = document.getElementById("advisor-counts");

  function updateStatus(status) {
    if (status === "connected") {
      dotEl.className = "status-dot connected";
      statusEl.textContent = "Connected";
      connectBtn.textContent = "Reconnect Bridge";
      connectBtn.disabled = false;
    } else if (status === "connecting") {
      dotEl.className = "status-dot";
      statusEl.textContent = "Connecting...";
      connectBtn.textContent = "Connecting...";
      connectBtn.disabled = true;
    } else {
      dotEl.className = "status-dot";
      statusEl.textContent = status === "error" ? "Connection Error" : "Disconnected";
      connectBtn.textContent = "Connect Bridge";
      connectBtn.disabled = false;
    }
  }

  async function pollAdvisorStatus() {
    try {
      const res = await fetch("http://localhost:9223/api/advisor/status");
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.metrics) {
          const m = data.metrics;
          const warnings = m.totalWarnings || 0;
          const pauses = m.totalPauses || 0;
          countsEl.textContent = `${warnings} / ${pauses}`;

          let health = 100 - (warnings * 15) - (pauses * 35);
          health = Math.max(0, Math.min(100, health));

          healthPctEl.textContent = `${health}%`;
          gaugeFillEl.style.width = `${health}%`;

          if (health > 70) {
            healthPctEl.style.color = "var(--success)";
            gaugeFillEl.style.background = "var(--success)";
          } else if (health > 35) {
            healthPctEl.style.color = "var(--warning)";
            gaugeFillEl.style.background = "var(--warning)";
          } else {
            healthPctEl.style.color = "var(--danger)";
            gaugeFillEl.style.background = "var(--danger)";
          }
        }
      }
    } catch {
      // Non-blocking poll failure
    }
  }

  chrome.storage.local.get(["remoteStatus"], (data) => {
    updateStatus(data.remoteStatus || "disconnected");
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.remoteStatus) {
      updateStatus(changes.remoteStatus.newValue);
    }
  });

  connectBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "connect" });
  });

  pollAdvisorStatus();
  setInterval(pollAdvisorStatus, 3000);
});
