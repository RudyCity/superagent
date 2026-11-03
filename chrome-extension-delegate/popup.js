"use strict";

const PROTOCOL = "superagent-delegate-v1";
const $ = (id) => document.getElementById(id);
const labels = {
  connected: ["Terhubung", "CONNECTED", "Handshake SuperAgent berhasil. Profil ini siap menerima perintah."],
  connecting: ["Menghubungkan...", "CONNECTING", "Sedang menunggu handshake SuperAgent."],
  reconnecting: ["Menyambung ulang...", "RECONNECTING", "Bridge belum tersedia. Extension akan mencoba kembali."],
  disconnected: ["Tidak terhubung", "OFFLINE", "Periksa proses SuperAgent dan port 17341."],
  disabled: ["Nonaktif", "OFF", "Koneksi untuk profil Chrome ini sengaja dimatikan."],
};
let refreshing = false;
let latestClientId = null;
let updating = false;
let renderedClientsKey = "";
let renderedTabsKey = "";

function displayTime(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Belum pernah";
  return new Date(value).toLocaleString("id-ID", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function makeClientRow(client, ownId) {
  const row = document.createElement("div");
  row.className = "client-row";
  const desc = document.createElement("div");
  desc.className = "client-description";
  const name = document.createElement("strong");
  name.textContent = client.label || "Chrome Delegate";
  desc.appendChild(name);
  if (client.clientId === ownId) {
    const own = document.createElement("span");
    own.className = "self-label";
    own.textContent = "profil ini";
    desc.appendChild(own);
  }
  const id = document.createElement("span");
  id.textContent = String(client.clientId || "");
  id.className = "client-id mono";
  desc.appendChild(id);
  const copy = document.createElement("button");
  copy.className = "copy-button";
  copy.textContent = "Salin ID";
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(String(client.clientId || ""));
      $("action-note").textContent = "Client ID disalin. Gunakan sebagai argumen clientId.";
    } catch {
      $("action-note").textContent = "Gagal menyalin. Pilih teks Client ID secara manual.";
    }
  });
  row.append(desc, copy);
  return row;
}

function renderClients(status) {
  const clients = Array.isArray(status?.connectedClients) ? status.connectedClients : [];
  $("connection-count").textContent = String(clients.length);
  const key = JSON.stringify([clients, status?.enabled, status?.clientId]);
  if (renderedClientsKey === key) return;
  renderedClientsKey = key;
  const container = $("connections");
  container.replaceChildren();
  if (!clients.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = status?.enabled === false
      ? "Koneksi lokal dimatikan."
      : "Tidak ada Chrome Delegate yang terdaftar pada koneksi ini.";
    container.append(empty);
    return;
  }
  for (const client of clients) container.append(makeClientRow(client, status.clientId));
}

function renderTabs(tabs) {
  const key = JSON.stringify(tabs.map(t => [t.id, t.active, t.ready]));
  if (renderedTabsKey === key) return;
  renderedTabsKey = key;
  const container = $("tab-list");
  container.replaceChildren();
  for (const tab of tabs.slice(0, 8)) {
    const item = document.createElement("div");
    item.className = "tab-row";
    const label = document.createElement("span");
    label.textContent = "Tab #" + tab.id + (tab.active ? " • aktif" : "") +
      (tab.ready ? " • siap" : " • belum siap");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy-button";
    copy.textContent = "Salin ID";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(String(tab.id));
        $("action-note").textContent = "Tab ID disalin. Gunakan sebagai argumen tabId.";
      } catch {
        $("action-note").textContent = "Gagal menyalin Tab ID.";
      }
    });
    item.append(label, copy);
    if (!tab.ready) {
      const repair = document.createElement("button");
      repair.className = "copy-button";
      repair.type = "button";
      repair.textContent = "Aktifkan";
      repair.addEventListener("click", async () => {
        repair.disabled = true;
        $("action-note").textContent = "Memasang content script pada tab #" + tab.id + "...";
        try {
          const result = await chrome.runtime.sendMessage({
            scope: PROTOCOL, action: "attach_content", tabId: tab.id,
          });
          if (!result?.ok) throw new Error(result?.error || "Tab tidak dapat diaktifkan.");
          $("action-note").textContent = "Tab #" + tab.id + " siap menerima perintah.";
        } catch (err) {
          $("action-note").textContent = String(err?.message || err);
        } finally {
          repair.disabled = false;
          await refreshStatus();
        }
      });
      item.appendChild(repair);
    }
    container.append(item);
  }
}

function renderStatus(status) {
  const state = labels[status?.state] ? status.state : "disconnected";
  const [title, pill, description] = labels[state];
  $("status-heading").textContent = title;
  $("status-pill").textContent = pill;
  $("status-dot").className = "status-dot " + state;
  $("status-pill").className = "status-pill " + state;
  let msg = description;
  if (state === "reconnecting" && typeof status.nextRetryAt === "number") {
    msg += " Berikutnya sekitar " + Math.max(0, Math.ceil((status.nextRetryAt - Date.now()) / 1000)) + " detik.";
  }
  $("status-description").textContent = msg;
  $("last-connected").textContent = displayTime(status?.lastConnectedAt);
  $("request-status").textContent = Number(status?.inFlight) > 0
    ? status.inFlight + " permintaan aktif" : "Tidak ada permintaan";
  $("client-id").textContent = status?.clientId || "Memuat...";
  $("auth-state").textContent = status?.authConfigured ? "TERPASANG" : "BELUM ADA";
  $("enabled").checked = status?.enabled !== false;
  if (!updating) $("enabled").disabled = false;
  if (status?.clientId !== latestClientId && !updating) {
    latestClientId = status.clientId || null;
    $("profile-label").value = String(status?.profileLabel || "Chrome Delegate");
  }
  renderClients(status);
  const err = state === "connected" ? "" : String(status?.lastError || "");
  $("error-info").hidden = !err;
  $("error-info").textContent = err;
  $("reconnect").disabled = status?.enabled === false || state === "connected" || state === "connecting";
}

async function refreshStatus() {
  if (refreshing || updating) return;
  refreshing = true;
  try {
    const [state, tabs] = await Promise.allSettled([
      chrome.runtime.sendMessage({ scope: PROTOCOL, action: "get_status" }),
      chrome.tabs.query({ url: "https://chatgpt.com/*" }),
    ]);
    if (state.status === "fulfilled" && state.value?.ok) {
      renderStatus(state.value.status);
    } else {
      renderStatus({ enabled: false, state: "disconnected", lastError: "Background extension tidak menjawab." });
      $("enabled").disabled = true;
    }
    if (tabs.status === "fulfilled") {
      // Read-only content-script probe. Never reload the page or dispatch
      // any ChatGPT mutation to "repair" a tab.
      const checked = await Promise.all(tabs.value.map(async tab => {
        try {
          const reply = await chrome.tabs.sendMessage(tab.id, {
            scope: PROTOCOL, action: "probe",
          });
          return { ...tab, ready: reply?.ready === true };
        } catch {
          return { ...tab, ready: false };
        }
      }));
      const readyCount = checked.filter(t => t.ready).length;
      const guarded = state.status === "fulfilled" && state.value?.ok
        ? Number(state.value.status?.tabPolicy?.protectedTabs?.length || 0) : 0;
      $("tab-status").textContent = checked.length
        ? readyCount + "/" + checked.length + " siap" +
          (guarded ? " • " + guarded + " dilindungi" : "")
        : "Tidak ada tab";
      renderTabs(checked);
    } else {
      $("tab-status").textContent = "Tidak dapat diperiksa";
      renderTabs([]);
    }
  } catch {
    $("action-note").textContent = "Status tidak dapat diambil dari extension.";
  } finally {
    refreshing = false;
  }
}

$("enabled").addEventListener("change", async () => {
  updating = true;
  $("enabled").disabled = true;
  const next = $("enabled").checked;
  try {
    const result = await chrome.runtime.sendMessage({
      scope: PROTOCOL, action: "set_enabled", enabled: next,
    });
    if (!result?.ok) throw new Error(result?.error || "Gagal memperbarui koneksi.");
    renderStatus(result.status);
    $("action-note").textContent = next
      ? "Koneksi diaktifkan. Tidak ada aksi chat yang diulang."
      : "Koneksi Delegate dimatikan. Tab ChatGPT tetap terbuka.";
  } catch (reason) {
    $("enabled").checked = !next;
    $("action-note").textContent = String(reason?.message || reason);
  } finally {
    updating = false;
    $("enabled").disabled = false;
    await refreshStatus();
  }
});

$("save-label").addEventListener("click", async () => {
  const label = $("profile-label").value.trim();
  try {
    const result = await chrome.runtime.sendMessage({ scope: PROTOCOL, action: "set_label", label });
    if (!result?.ok) throw new Error(result?.error || "Gagal menyimpan nama.");
    $("action-note").textContent = "Nama koneksi tersimpan.";
    renderStatus(result.status);
  } catch (reason) {
    $("action-note").textContent = String(reason?.message || reason);
  }
});

$("save-pairing").addEventListener("click", async () => {
  const token = $("pairing-key").value;
  const code = /^[A-HJ-NP-Z2-9]{8}$/.test(token.toUpperCase().replace(/[\s-]/g, ""));
  const legacy = token.length >= 32 && token.length <= 512;
  if (token !== "" && !code && !legacy) {
    $("action-note").textContent = "Kode harus 8 karakter sesuai yang tampil di terminal.";
    return;
  }
  $("save-pairing").disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      scope: PROTOCOL, action: "set_pairing", token,
    });
    if (!result?.ok) throw new Error(result?.error || "Gagal menyimpan kunci.");
    $("pairing-key").value = "";
    $("action-note").textContent = code
      ? "Kode dikirim untuk pairing. Periksa status CONNECTED."
      : "Kunci tersimpan. Koneksi sedang diverifikasi ulang.";
    renderStatus(result.status);
  } catch (reason) {
    $("action-note").textContent = String(reason?.message || reason);
  } finally {
    $("save-pairing").disabled = false;
  }
});

$("reconnect").addEventListener("click", async () => {
  $("reconnect").disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ scope: PROTOCOL, action: "reconnect" });
    if (!result?.ok) throw new Error(result?.error || "Gagal membuka koneksi.");
    renderStatus(result.status);
    $("action-note").textContent = result.started
      ? "Koneksi baru dicoba. Tidak ada pesan yang dikirim ulang."
      : "Koneksi masih aktif atau sedang dijalankan.";
  } catch {
    $("action-note").textContent = "Gagal menghubungkan. Periksa server.";
  }
  await refreshStatus();
});

void refreshStatus();
const interval = setInterval(() => { void refreshStatus(); }, 1500);
window.addEventListener("pagehide", () => clearInterval(interval));
