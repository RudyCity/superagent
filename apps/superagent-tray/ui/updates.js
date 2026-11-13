"use strict";
/* Release UX: check and download are operator-initiated. Never execute an installer,
 * restart a service, prompt for credentials, or trust an arbitrary remote URL. */
(() => {
  const byId = (id) => document.getElementById(id);
  const invoke = (action, args = {}) => {
    const api = window.__TAURI__?.core?.invoke;
    if (typeof api !== "function") throw new Error("TRAY_NATIVE_ONLY");
    return api(action, args);
  };
  let busy = false;
  let snapshot = null;
  let checkedAt = 0;
  const state = byId("updates-state");
  const feedback = byId("updates-feedback");
  const check = byId("updates-check");
  const download = byId("updates-download");
  const downloaded = byId("updates-downloaded");

  function message(text, isError = false) {
    if (!feedback) return;
    feedback.textContent = text;
    feedback.dataset.state = isError ? "error" : "ready";
  }
  function clearSelection() {
    snapshot = null;
    if (download) download.disabled = true;
    if (downloaded) downloaded.hidden = true;
    const list = byId("updates-components");
    if (list) list.textContent = "No trusted release data available.";
  }
  function busyState(active) {
    busy = active;
    if (check) {
      check.disabled = active;
      check.textContent = active ? "Checking…" : "Check Releases";
    }
    if (download) {
      download.disabled = active || !snapshot?.downloadSupported;
      download.textContent = active && snapshot ? "Downloading / verifying…" : "Download verified installer";
    }
  }
  function draw(info) {
    snapshot = info;
    byId("updates-current-version").textContent = info.currentVersion || "Unknown";
    byId("updates-release-version").textContent = info.releaseVersion || "Unknown";
    byId("updates-release-tag").textContent = info.tag || "No release tag";
    byId("updates-platform").textContent = info.platform || "Unsupported platform";
    byId("updates-asset").textContent = info.assetName || "No matching native installer";
    state.textContent = {
      update_available: "Update available",
      same_version: "Version matches",
      installed_newer: "Development build",
      unknown_installed_version: "Version unknown"
    }[info.state] || "Release checked";
    const size = byId("updates-download-size");
    if (size) {
      size.textContent = Number.isFinite(info.assetSize)
        ? `${(info.assetSize / 1048576).toFixed(1)} MiB · Published SHA-256 · checked after download`
        : "No compatible package for this OS/architecture";
    }
    const list = byId("updates-components");
    if (list) {
      list.replaceChildren();
      for (const name of Array.isArray(info.components) ? info.components : []) {
        const row = document.createElement("span");
        row.className = "update-component";
        row.textContent = name;
        list.append(row);
      }
      if (!list.childElementCount) list.textContent = "No verified packages in this release.";
    }
    if (!info.downloadSupported) {
      message("This OS or architecture has no matching standalone package in the published prerelease.", true);
    } else if (info.state === "same_version") {
      message("Installed and published versions match. You can still download a verified installer for repair or reinstallation.");
    } else if (info.state === "installed_newer") {
      message("This installation is newer than the published release; downloading would be a manual downgrade.");
    } else {
      message("Official release and checksum verified. Review the package before downloading.");
    }
    if (download) download.disabled = !info.downloadSupported;
  }
  function safeFailure(error) {
    const code = String(error || "");
    if (code.includes("UPDATE_RELEASE_CHANGED_SINCE_REVIEW")) {
      return "Published release changed during download review. Check releases again.";
    }
    if (code.includes("UPDATE_EXISTING_CHECKSUM_MISMATCH") || code.includes("UPDATE_DOWNLOAD_HASH_OR_SIZE_MISMATCH")) {
      return "Local file or download checksum mismatch. No installer was executed. Review downloads manually.";
    }
    if (code.includes("TRAY_NATIVE_ONLY")) return "Updates are available only in the native desktop Tray.";
    return "Official release could not be verified. Check your connection and retry; no changes were applied.";
  }
  async function checkUpdates(force = false) {
    if (busy || (!force && snapshot && Date.now() - checkedAt < 300000)) return;
    clearSelection();
    busyState(true);
    state.textContent = "Checking…";
    message("Contacting the official GitHub repository and validating release checksums…");
    try {
      const result = await invoke("check_release_updates");
      if (!result || typeof result.tag !== "string" ||
          !/^v\d+\.\d+\.\d+-rc\.\d+$/.test(result.tag) ||
          (result.downloadSupported && !/^[0-9a-f]{64}$/i.test(result.sha256 || ""))) {
        throw new Error("UPDATE_INVALID_RESPONSE");
      }
      draw(result);
      checkedAt = Date.now();
    } catch (error) {
      clearSelection();
      state.textContent = "Check failed";
      message(safeFailure(error), true);
    } finally {
      busyState(false);
    }
  }
  async function downloadUpdate() {
    if (busy || !snapshot?.downloadSupported) return;
    const selected = snapshot;
    // A browser confirm is only UX. Rust checks tag, checksum, origin and asset
    // again at execution. This is manual DOWNLOAD only, never installation.
    if (!window.confirm(`Download ${selected.assetName} (${selected.tag})?\n\nThe file will be SHA-256 verified. Nothing will be installed, restarted or stopped.`)) return;
    busyState(true);
    message("Downloading the release into Downloads/SuperAgent/updates and verifying its SHA-256…");
    try {
      const receipt = await invoke("download_release_update", {
        expectedTag: selected.tag,
        expectedSha256: selected.sha256
      });
      if (!receipt || receipt.tag !== selected.tag || receipt.sha256 !== selected.sha256 || receipt.installed !== false) {
        throw new Error("UPDATE_RECEIPT_INVALID");
      }
      const path = byId("updates-downloaded-path");
      if (path) path.textContent = receipt.filePath;
      if (downloaded) downloaded.hidden = false;
      state.textContent = "Download verified";
      message("Verified installer downloaded. Open it manually during a safe maintenance window.");
    } catch (error) {
      message(safeFailure(error), true);
      if (String(error || "").includes("UPDATE_RELEASE_CHANGED_SINCE_REVIEW")) {
        clearSelection();
        state.textContent = "Recheck required";
      }
    } finally {
      busyState(false);
    }
  }
  check?.addEventListener("click", () => void checkUpdates(true));
  download?.addEventListener("click", () => void downloadUpdate());
  window.__superagentUpdatesRefresh = () => checkUpdates();
  if (window.location.hash === "#updates") void checkUpdates();
})();