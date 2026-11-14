/* Hallmark · component: native settings · genre: utility · theme: existing Tray tokens
 * states: default · hover · focus · active · disabled · loading · error · success
 * critique: P5 H4 E5 S5 R5 V4
 * Cloudflare Named Tunnel settings. Saving never launches/stops a tunnel.
 */
(() => {
  "use strict";
  const el = (id) => document.getElementById(id);
  const invoke = (command, args) => {
    const native = window.__TAURI__?.core?.invoke;
    if (!native) throw new Error("Named Tunnel settings require the native Tray.");
    return native(command, args);
  };
  const fields = {
    connectorMode: "named-tunnel-mode",
    tunnelId: "named-tunnel-id",
    hostname: "named-tunnel-hostname",
    anchorPort: "named-tunnel-anchor-port",
    ownerPort: "named-tunnel-owner-port",
    tokenFilePath: "named-tunnel-token-file",
    credentialsFilePath: "named-tunnel-credentials-file",
    cloudflaredPath: "named-tunnel-binary",
  };
  let busy = false;
  function updateMode() {
    const remote = el("named-tunnel-mode")?.value === "remote-managed";
    if (el("named-tunnel-token-row")) el("named-tunnel-token-row").hidden = !remote;
    if (el("named-tunnel-credentials-row")) el("named-tunnel-credentials-row").hidden = remote;
  }
  function readForm() {
    const get = (field) => el(fields[field])?.value?.trim() ?? "";
    const mode = get("connectorMode");
    if (!["remote-managed", "local-managed"].includes(mode)) {
      throw new Error("Unsupported connector mode.");
    }
    const hostname = get("hostname").toLowerCase();
    const uuid = get("tunnelId").toLowerCase();
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+){2,}$/.test(hostname) ||
        hostname.endsWith(".trycloudflare.com") || hostname.endsWith(".cfargotunnel.com")) {
      throw new Error("Enter an owned Cloudflare hostname, such as mcp.rcity.web.id.");
    }
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(uuid)) {
      throw new Error("Enter the Cloudflare Tunnel UUID, not a token.");
    }
    const anchorPort = Number(get("anchorPort"));
    const ownerPort = Number(get("ownerPort"));
    if (!Number.isInteger(anchorPort) || !Number.isInteger(ownerPort) ||
        anchorPort < 1024 || ownerPort < 1024 ||
        anchorPort > 65535 || ownerPort > 65535 || anchorPort === ownerPort ||
        [9227, 7888, 6759, 6789, 9877].includes(anchorPort) ||
        [9227, 7888, 6759, 6789, 9877].includes(ownerPort)) {
      throw new Error("Choose separate, unused private ports, not the active Core/MCP ports.");
    }
    const file = mode === "remote-managed" ? get("tokenFilePath") : get("credentialsFilePath");
    if (file && (!/^(?:[a-zA-Z]:\\|\/)/.test(file) || /[\r\n"']/.test(file))) {
      throw new Error("Use an absolute local credential file path. Never paste the token.");
    }
    return {
      version: 1, connectorMode: mode, tunnelId: uuid, hostname,
      anchorPort, ownerPort,
      tokenFilePath: mode === "remote-managed" ? get("tokenFilePath") : "",
      credentialsFilePath: mode === "local-managed" ? get("credentialsFilePath") : "",
      cloudflaredPath: get("cloudflaredPath"),
    };
  }
  function display(view) {
    const settings = view?.settings;
    if (!settings || settings.version !== 1) throw new Error("Invalid native settings response.");
    for (const [field, id] of Object.entries(fields)) {
      if (el(id)) el(id).value = String(settings[field] ?? "");
    }
    updateMode();
    const tag = el("named-tunnel-status");
    const output = el("named-tunnel-readiness");
    if (tag) {
      tag.textContent = ({
        not_configured: "Not configured",
        credential_file_missing: "Credential missing",
        cloudflared_missing: "cloudflared missing",
        configured_not_connected: "Configured · not connected",
      })[view.status] || "Review required";
    }
    if (output) {
      const facts = [
        view.configured ? "Hostname and tunnel ID saved." : "Hostname and tunnel ID not configured.",
        view.credentialFilePresent ? "Credential file present (contents not certified)." : "Credential file not verified.",
        view.cloudflaredPresent ? "cloudflared file present." : "cloudflared executable not verified.",
        "DNS and external connector not checked.",
        "No activation or live Quick Tunnel change.",
      ];
      output.textContent = facts.join(" ");
      output.dataset.state = view.status === "configured_not_connected" ? "success" : "warning";
    }
  }
  async function load() {
    if (busy) return;
    try {
      display(await invoke("get_named_tunnel_settings"));
      if (el("named-tunnel-feedback")) el("named-tunnel-feedback").textContent = "";
    } catch (error) {
      if (el("named-tunnel-status")) el("named-tunnel-status").textContent = "Unavailable";
      if (el("named-tunnel-feedback")) {
        el("named-tunnel-feedback").textContent = "Cannot read Named Tunnel settings: " + String(error);
      }
    }
  }
  async function save(event) {
    event?.preventDefault?.();
    if (busy) return;
    const button = el("named-tunnel-save");
    busy = true;
    if (button) { button.disabled = true; button.dataset.loading = "true"; }
    try {
      const settings = readForm();
      const view = await invoke("set_named_tunnel_settings", { settings });
      display(view);
      if (typeof Event === "function")
        window.dispatchEvent?.(new Event("named-tunnel-settings-changed"));
      el("named-tunnel-feedback").textContent =
        "Saved locally. Named Tunnel and DNS were NOT changed. Activation still requires a separate verified handoff.";
      window.TrayFeedback?.notify?.({ kind:"success", message:"Named Tunnel settings saved locally.", scope:"settings" });
    } catch (error) {
      el("named-tunnel-feedback").textContent = "NOT saved: " + String(error);
      window.TrayFeedback?.notify?.({ kind:"error", message:"Named Tunnel settings rejected.", scope:"settings" });
    } finally {
      busy = false;
      if (button) { button.disabled = false; delete button.dataset.loading; }
    }
  }
  function install() {
    el("named-tunnel-mode")?.addEventListener("change", updateMode);
    el("named-tunnel-settings-form")?.addEventListener("submit", save);
    el("named-tunnel-check")?.addEventListener("click", () => { void load(); });
    window.__TAURI__?.event?.listen?.("desktop-open-settings", () => { void load(); });
    window.addEventListener?.("named-tunnel-settings-refresh", () => { void load(); });
    void load();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once:true });
  } else { install(); }
})();
