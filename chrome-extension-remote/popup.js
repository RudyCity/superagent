document.addEventListener("DOMContentLoaded", () => {
  const dotEl = document.getElementById("dot");
  const statusEl = document.getElementById("status-text");
  const connectBtn = document.getElementById("btn-connect");

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
});
