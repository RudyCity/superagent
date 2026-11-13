"use strict";
/* Each component downloads independently from the verified official release.
 * This manager never installs, executes, restarts, or takes process ownership. */
(() => {
  const byId = id => document.getElementById(id);
  const invoke = (action, args = {}) => {
    const api = window.__TAURI__?.core?.invoke;
    if (typeof api !== "function") throw new Error("TRAY_NATIVE_ONLY");
    return api(action, args);
  };
  const state = byId("updates-state");
  const feedback = byId("updates-feedback");
  const check = byId("updates-check");
  const download = byId("updates-download");
  const downloaded = byId("updates-downloaded");
  let busy = false;
  let snapshot = null;
  let checkedAt = 0;
  let componentButtons = [];

  function message(text, isError = false) {
    if (!feedback) return;
    feedback.textContent = text;
    feedback.dataset.state = isError ? "error" : "ready";
  }
  function clearSelection() {
    snapshot = null;
    componentButtons = [];
    if (download) download.disabled = true;
    if (downloaded) downloaded.hidden = true;
    const list = byId("updates-components");
    if (list) list.textContent = "No trusted release data available.";
  }
  function busyState(active, mode = "check") {
    busy = active;
    if (check) {
      check.disabled = active;
      check.textContent = active && mode === "check" ? "Checking…" : "Check Releases";
    }
    if (download) {
      download.disabled = active || !snapshot?.downloadSupported;
      download.textContent = active && mode === "download" ? "Downloading / verifying…" : "Download verified installer";
    }
    for (const [button, item] of componentButtons) {
      button.disabled = active || !item.available || !item.sha256;
      button.textContent = active && mode === "download" ? "Verifying…" : "Download verified package";
    }
  }
  function element(tag, css, text) {
    const item = document.createElement(tag);
    if (css) item.className = css;
    item.textContent = text;
    return item;
  }
  function drawComponentItems(items) {
    const list = byId("updates-components");
    if (!list) return;
    list.replaceChildren();
    componentButtons = [];
    for (const item of items) {
      const row = element("article", "update-component-card", "");
      const title = element("div", "update-component-title", "");
      const heading = element("strong", "", item.label || item.id || "Unknown component");
      const flag = element("span", "update-component-state", !item.available ? "Not in release" :
        item.state === "update_available" ? "Update available" :
        item.state === "same_version" ? "Version matches" :
        item.state === "build_unverified" ? "Build provenance unknown" :
        item.state === "installed_newer" ? "Installed version newer" :
        "Installed version not detected");
      title.append(heading, flag);
      const version = element("p", "update-component-version",
        `Published ${item.version || "—"} · Installed ${item.installedVersion || "Unknown"} · ${item.platform || ""}`);
      const filename = element("p", "update-component-file",
        item.fileName || "No compatible package in this release");
      const detail = element("p", "update-component-help",
        item.instructions || "Manual installation required.");
      const controls = element("div", "update-component-actions", "");
      const button = element("button", "button secondary update-component-download",
        "Download verified package");
      button.type = "button";
      button.disabled = !item.available || !item.sha256;
      button.addEventListener("click", () => void downloadSelected(item));
      controls.append(button);
      if (item.size) controls.append(element("small", "update-muted",
        `${(item.size / 1048576).toFixed(1)} MiB · SHA-256 verified`));
      row.append(title, version, filename, detail, controls);
      list.append(row);
      componentButtons.push([button, item]);
    }
    if (!items.length) list.textContent = "No supported components in this release.";
  }
  function draw(info) {
    snapshot = info;
    byId("updates-current-version").textContent = info.installedReleaseTag
      ? `${info.currentVersion || "Unknown"} · ${info.installedReleaseTag}`
      : info.currentVersion || "Unknown";
    byId("updates-release-version").textContent = info.releaseVersion || "Unknown";
    byId("updates-release-tag").textContent = info.tag || "No release tag";
    byId("updates-platform").textContent = info.platform || "Unsupported platform";
    byId("updates-asset").textContent = info.assetName || "No matching native installer";
    state.textContent = {
      update_available: "Update available",
      same_version: "Version matches",
      installed_newer: "Development build",
      unknown_installed_version: "Version unknown",
      build_unverified: "Build provenance unverified"
    }[info.state] || "Release checked";
    const size = byId("updates-download-size");
    if (size) {
      size.textContent = Number.isFinite(info.assetSize)
        ? `${(info.assetSize / 1048576).toFixed(1)} MiB · Published SHA-256 · checked after download`
        : "No compatible native installer; other components may be available below";
    }
    const items = Array.isArray(info.componentItems) ? info.componentItems : [];
    if (items.length) drawComponentItems(items);
    else {
      const list = byId("updates-components");
      componentButtons = [];
      if (list) {
        list.replaceChildren();
        for (const name of Array.isArray(info.components) ? info.components : []) {
          list.append(element("span", "update-component", name));
        }
        if (!list.childElementCount) list.textContent = "No verified packages in this release.";
      }
    }
    if (!info.downloadSupported) message("No main installer for this OS/architecture; individual companion packages may still be available below.");
    else if (info.state === "same_version") message("Main Tray version matches; each companion component can be downloaded independently.");
    else if (info.state === "installed_newer") message("This Tray is newer than the published release. Companion versions remain independently managed.");
    else if (info.state === "build_unverified") message("The base version matches, but this running binary has no verified release tag. You can download the official package manually.");
    else message("Published release and individual checksums verified. Review each component before downloading.");
    if (download) download.disabled = !info.downloadSupported;
  }
  function safeFailure(error) {
    const code = String(error || "");
    if (code.includes("UPDATE_RELEASE_CHANGED_SINCE_REVIEW")) return "Published release changed. Check releases again before downloading.";
    if (code.includes("UPDATE_EXISTING_CHECKSUM_MISMATCH") ||
        code.includes("UPDATE_DOWNLOAD_HASH_OR_SIZE_MISMATCH")) {
      return "Downloaded or existing file checksum mismatch. Nothing was executed. Inspect the file manually.";
    }
    if (code.includes("UPDATE_COMPONENT_NOT_ALLOWED") || code.includes("UPDATE_ASSET_ORIGIN_MISMATCH")) {
      return "Selected component is not a recognized official release package.";
    }
    if (code.includes("TRAY_NATIVE_ONLY")) return "Updates are available only in the native desktop Tray.";
    return "Official package could not be verified or downloaded. No changes were applied.";
  }
  async function checkUpdates(force = false) {
    if (busy || (!force && snapshot && Date.now() - checkedAt < 300000)) return;
    clearSelection();
    busyState(true, "check");
    state.textContent = "Checking…";
    message("Verifying the official release and SHA-256 for each component…");
    try {
      const info = await invoke("check_release_updates");
      if (!info || !/^v\d+\.\d+\.\d+-rc\.\d+$/.test(info.tag || "") ||
        (info.downloadSupported && !/^[0-9a-f]{64}$/i.test(info.sha256 || "")) ||
        (Array.isArray(info.componentItems) && info.componentItems.some(item =>
          item.available && (!/^[0-9a-f]{64}$/i.test(item.sha256 || "") ||
          !/^[a-z0-9-]+$/.test(item.id || ""))))) {
        throw new Error("UPDATE_INVALID_RESPONSE");
      }
      draw(info);
      checkedAt = Date.now();
    } catch (error) {
      clearSelection();
      state.textContent = "Check failed";
      message(safeFailure(error), true);
    } finally { busyState(false); }
  }
  async function downloadSelected(item, legacy = false) {
    if (busy || !snapshot || !item?.available && !legacy) return;
    if (legacy && !snapshot.downloadSupported) return;
    const selected = snapshot;
    const target = legacy ? {fileName:selected.assetName, sha256:selected.sha256, id:"superagent"} : item;
    if (!target?.sha256 || !target.fileName) return;
    if (!window.confirm(`Download ${target.fileName} (${selected.tag})?\n\nSHA-256 will be verified. This will not install, reload Chrome, install an APK, restart Tray or interrupt active transfers.`)) return;
    busyState(true, "download");
    message(`Downloading and verifying ${target.fileName} into Downloads/SuperAgent/updates…`);
    try {
      const receipt = await invoke(legacy ? "download_release_update" : "download_release_component",
        legacy ? {expectedTag:selected.tag, expectedSha256:target.sha256}
          : {componentId:target.id, expectedTag:selected.tag, expectedSha256:target.sha256});
      if (!receipt || receipt.tag !== selected.tag || receipt.sha256 !== target.sha256 ||
          receipt.fileName && receipt.fileName !== target.fileName || receipt.installed !== false) {
        throw new Error("UPDATE_RECEIPT_INVALID");
      }
      const path = byId("updates-downloaded-path");
      if (path) path.textContent = receipt.filePath || "Verified download";
      if (downloaded) downloaded.hidden = false;
      state.textContent = "Download verified";
      message(`${target.fileName} verified. Follow its component-specific installation instructions; no running services were stopped.`);
    } catch (error) {
      message(safeFailure(error), true);
      if (String(error || "").includes("UPDATE_RELEASE_CHANGED_SINCE_REVIEW")) {
        clearSelection();
        state.textContent = "Recheck required";
      }
    } finally {busyState(false);}
  }
  check?.addEventListener("click", () => void checkUpdates(true));
  download?.addEventListener("click", () => void downloadSelected(null, true));
  window.__superagentUpdatesRefresh = () => checkUpdates();
  if (window.location.hash === "#updates") void checkUpdates();
})();