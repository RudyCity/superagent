/* Hallmark · component: Named Tunnel operations · genre: utility · theme: Tray tokens
 * states: default · hover · focus · active · disabled · loading · error · success
 * critique: P5 H4 E5 S5 R5 V4
 * Only the native backend may read tokens or control a verified connector.
 */
(() => {
  "use strict";
  const el = (id) => document.getElementById(id);
  const invoke = (command, args) => {
    const native = window.__TAURI__?.core?.invoke;
    if (!native) throw Error("Named Tunnel operations require the native Tray.");
    return native(command, args);
  };
  let busy = false;
  let last = null;
  const text = (id, value) => {
    const node = el(id);
    if (node) node.textContent = String(value);
  };
  function apply(health) {
    if (!health || health.quickTunnelUntouched !== true) {
      throw Error("Named Tunnel health evidence is invalid.");
    }
    last = health;
    text("named-tunnel-connector-health", health.connectorStatus || "Not verified");
    text("named-tunnel-anchor-health", health.anchorStatus || "Not verified");
    text("named-tunnel-owner-health", health.ownerStatus || "Not verified");
    text("named-tunnel-edge-health",
      health.edgeHttpStatus == null ? "Unreachable / not checked" :
      "HTTP " + String(health.edgeHttpStatus) +
      (health.mcpAuthChallengeObserved ? " · OAuth challenge" : " · OAuth not verified"));
    text("named-tunnel-health-reason",
      (health.reason || "Review required.") +
      " Cutover is disabled until Gemini is separately authorized. The Quick Tunnel is unchanged.");
    const canStart = health.tokenVerified === true &&
      health.anchorStatus === "verified_local" &&
      health.connectorStatus === "not_started";
    if (el("named-tunnel-start")) el("named-tunnel-start").disabled = !canStart;
    if (el("named-tunnel-stop")) el("named-tunnel-stop").disabled =
      !["verified_local_only","credential_missing_but_owned"].includes(health.connectorStatus) ||
      health.anchorStatus === "verified_local";
    if (el("named-tunnel-plan")) el("named-tunnel-plan").disabled =
      health.tokenVerified !== true;
    el("named-tunnel-health")?.setAttribute?.("data-state",
      health.connectorStatus === "verified_local_only" && health.ownerStatus === "verified_local"
        ? "success" : "warning");
  }
  async function refreshHealth() {
    if (busy) return;
    busy = true;
    if (el("named-tunnel-check")) el("named-tunnel-check").disabled = true;
    try {
      const health = await invoke("get_named_tunnel_health");
      apply(health);
    } catch (error) {
      text("named-tunnel-health-reason", "Cannot verify Named Tunnel: " + String(error));
      text("named-tunnel-connector-health", "Unavailable");
      for (const id of ["named-tunnel-start", "named-tunnel-stop", "named-tunnel-plan"]) {
        if (el(id)) el(id).disabled = true;
      }
    } finally {
      busy = false;
      if (el("named-tunnel-check")) el("named-tunnel-check").disabled = false;
    }
  }
  async function importToken(source = "file") {
    if (busy) return;
    busy = true;
    if (el("named-tunnel-import-token")) el("named-tunnel-import-token").disabled = true;
    if (el("named-tunnel-import-clipboard")) el("named-tunnel-import-clipboard").disabled = true;
    try {
      const response = await invoke(source === "clipboard" ? "import_named_tunnel_clipboard" : "pick_named_tunnel_token");
      if (response === null) {
        text("named-tunnel-token-feedback", "Import cancelled. No token changed.");
      } else {
        text("named-tunnel-token-feedback",
          "Cloudflare token imported into the private native Tray profile. No connector was started.");
        window.dispatchEvent?.(new Event("named-tunnel-settings-refresh"));
      }
    } catch (error) {
      text("named-tunnel-token-feedback", "Import refused: " + String(error));
    } finally {
      busy = false;
      if (el("named-tunnel-import-token")) el("named-tunnel-import-token").disabled = false;
      if (el("named-tunnel-import-clipboard")) el("named-tunnel-import-clipboard").disabled = false;
    }
    void refreshHealth();
  }
  async function plan() {
    if (busy) return;
    busy = true;
    if (el("named-tunnel-plan")) el("named-tunnel-plan").disabled = true;
    try {
      const proposal = await invoke("plan_named_tunnel_connector");
      if (proposal?.noQuickTunnelMutation !== true) throw Error("Invalid connector plan.");
      text("named-tunnel-feedback",
        "Reviewed target: " + String(proposal.status.hostname) +
        " · tunnel " + String(proposal.status.tunnelId) +
        " · " + String(proposal.status.status) +
        ". No process changed. Connector start requires separate native confirmation.");
    } catch (error) {
      text("named-tunnel-feedback", "Plan blocked: " + String(error));
    } finally {
      busy = false;
      if (el("named-tunnel-plan")) el("named-tunnel-plan").disabled = false;
    }
  }
  async function change(action) {
    if (busy || !["start", "stop"].includes(action)) return;
    busy = true;
    const button = el("named-tunnel-" + action);
    if (button) {
      button.disabled = true;
      button.dataset.loading = "true";
    }
    try {
      // The OS approval dialog is in the Rust backend; a compromised WebView
      // cannot bypass it by setting "reviewed" in this request.
      const config = await invoke("get_named_tunnel_settings");
      const tunnelId = config?.settings?.tunnelId;
      if (!tunnelId || !/^[0-9a-f-]{36}$/.test(tunnelId)) {
        throw Error("Save the correct Cloudflare Tunnel UUID first.");
      }
      const result = await invoke("named_tunnel_connector_action", {
        action, expectedTunnelId: tunnelId, reviewed: true,
      });
      if (result?.noQuickTunnelMutation !== true) throw Error("Connector ownership not verified.");
      text("named-tunnel-feedback",
        "Connector action " + action + " completed. No Quick Tunnel or DNS action performed.");
    } catch (error) {
      text("named-tunnel-feedback", "Connector " + action + " blocked: " + String(error));
    } finally {
      busy = false;
      if (button) {
        button.disabled = false;
        delete button.dataset.loading;
      }
    }
    void refreshHealth();
  }
  function install() {
    if (el("named-tunnel-start")) el("named-tunnel-start").disabled = true;
    if (el("named-tunnel-stop")) el("named-tunnel-stop").disabled = true;
    if (el("named-tunnel-plan")) el("named-tunnel-plan").disabled = true;
    el("named-tunnel-import-token")?.addEventListener("click", () => void importToken("file"));
    el("named-tunnel-import-clipboard")?.addEventListener("click", () => void importToken("clipboard"));
    el("named-tunnel-plan")?.addEventListener("click", () => void plan());
    el("named-tunnel-start")?.addEventListener("click", () => void change("start"));
    el("named-tunnel-stop")?.addEventListener("click", () => void change("stop"));
    el("named-tunnel-check")?.addEventListener("click", () => void refreshHealth());
    window.addEventListener?.("named-tunnel-settings-changed", () => void refreshHealth());
    void refreshHealth();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, {once:true});
  } else install();
})();
