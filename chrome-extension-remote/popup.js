document.addEventListener("DOMContentLoaded", () => {
  const dotEl = document.getElementById("dot");
  const statusEl = document.getElementById("status-text");

  function updateStatus() {
    chrome.storage.local.get(["remoteStatus"], (data) => {
      const status = data.remoteStatus || "disconnected";
      if (status === "connected") {
        dotEl.className = "status-dot connected";
        statusEl.textContent = "Connected";
      } else {
        dotEl.className = "status-dot";
        statusEl.textContent = status === "error" ? "Connection Error" : "Disconnected";
      }
    });
  }

  updateStatus();
  setInterval(updateStatus, 2000);
});
