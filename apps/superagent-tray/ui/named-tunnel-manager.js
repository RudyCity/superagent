/* Hallmark · component: Cloudflare named stack manager · inherited Tray tokens
 * states: default · hover · focus · active · disabled · loading · error · success
 * critique: P5 H4 E5 S5 R5 V4
 * A read-only status is not permission to mutate: the operator must request a
 * verified plan and confirm an exact owner-scoped native operation.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  const ACTIONS = ["start-anchor", "start-owner", "stop-owner", "stop-anchor"];
  const ids = {
    "start-anchor": "named-manager-start-anchor",
    "start-owner": "named-manager-start-owner",
    "stop-owner": "named-manager-stop-owner",
    "stop-anchor": "named-manager-stop-anchor",
  };
  const state = {busy:false, saved:null, status:null, health:null, plan:null};

  function invoke(command, args) {
    const native = window.__TAURI__?.core?.invoke;
    if (typeof native !== "function") throw Error("NATIVE_UNAVAILABLE");
    return native(command, args);
  }
  function setText(id, value) {
    const node = $(id);
    if (node) node.textContent = String(value);
  }
  function setState(id, status, text) {
    const el = $(id);
    if (!el) return;
    el.dataset.state = status;
    el.textContent = text;
  }
  function report(kind, message) {
    const node = $("named-manager-message");
    if (node) {
      node.dataset.state = kind;
      node.textContent = message;
    }
  }
  // No raw native exception text: it may include a token, command line or path.
  function safeReason(error) {
    const input = String(error?.code || error?.message || error).toUpperCase();
    if (/UNKNOWN COMMAND|UNKNOWN IPC|NOT FOUND|UNRECOGNIZED|UNSUPPORTED COMMAND/.test(input))
      return "Installed Tray backend does not provide this manager command. Update the native Tray build; existing Quick Tunnel remains active.";
    if (/PERMISSION|DENIED|NOT AUTHORIZED|APPROVAL/.test(input))
      return "Permission or native approval denied. Use an operator-authorized Tray session, then retry.";
    if (/TOKEN|CREDENTIAL/.test(input))
      return "Token/credential verification failed. Import again using the native clipboard or file picker.";
    if (/PORT|LISTENER|IN USE|EADDRINUSE/.test(input))
      return "An isolated port or listener failed verification. Inspect ports 19320/19321 without stopping an existing owner.";
    if (/OWNER|IDENTITY|STALE|PROCESS/.test(input))
      return "Owner identity is unverified or stale. Refresh status and request a new plan; never adopt an unrelated process.";
    if (/NATIVE_UNAVAILABLE/.test(input))
      return "Native Tauri commands are unavailable. Open the installed desktop Tray, not this page in a browser.";
    return "Readiness could not be verified. Check the native Tray diagnostics, configured profile and permissions; no service change is permitted.";
  }
  function savedConfig(view) {
    const value = view?.settings;
    if (!value || value.version !== 1 || !UUID.test(String(value.tunnelId || ""))) return null;
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+){2,}$/.test(String(value.hostname || ""))) return null;
    if (!Number.isInteger(value.anchorPort) || !Number.isInteger(value.ownerPort) ||
        value.anchorPort === value.ownerPort) return null;
    return {
      tunnelId: value.tunnelId, hostname: value.hostname,
      anchorPort: value.anchorPort, ownerPort: value.ownerPort,
    };
  }
  function formMatchesSaved() {
    const c = state.saved;
    if (!c) return false;
    return ($("named-tunnel-id")?.value || "").trim().toLowerCase() === c.tunnelId &&
      ($("named-tunnel-hostname")?.value || "").trim().toLowerCase() === c.hostname &&
      Number($("named-tunnel-anchor-port")?.value) === c.anchorPort &&
      Number($("named-tunnel-owner-port")?.value) === c.ownerPort;
  }
  function safeStatus(raw, saved) {
    if (!raw || raw.quickTunnelUntouched !== true || !saved) return null;
    const data = raw.status && typeof raw.status === "object" ? raw.status : raw;
    const identity = data.tunnelId || raw.tunnelId || data.expectedTunnelId;
    if (identity !== saved.tunnelId || data.hostname !== saved.hostname ||
        data.anchorPort !== saved.anchorPort || data.ownerPort !== saved.ownerPort ||
        data.configured !== true) return null;
    return data;
  }
  function isVerified(entry) {
    return entry === "verified_local" || (entry && typeof entry === "object" &&
      entry.verified === true && entry.state === "verified_local");
  }
  function getFlag(s, key) {
    return s?.[key] === true;
  }
  function stepState() {
    const s = state.status;
    const h = state.health;
    const profile = Boolean(state.saved && s && formMatchesSaved());
    const credential = profile && (getFlag(s, "tokenVerified") || getFlag(s, "credentialVerified"));
    // The native orchestrator returns attested component objects; do not let
    // a stale summary string shadow those authenticated component states.
    const anchor = profile && isVerified(s.anchor ?? s.anchorStatus);
    const owner = profile && isVerified(s.owner ?? s.ownerStatus);
    const connector = profile && (
      s.connectorStatus === "verified_local_only" || s.connectorStatus === "verified_local" ||
      h?.connectorStatus === "verified_local_only");
    const edge = profile && h?.quickTunnelUntouched === true &&
      h.edgeObserved === true && h.mcpAuthChallengeObserved === true;
    const oauth = profile && s.oauthVerified === true;
    const gemini = profile && s.geminiVerified === true;
    setState("named-manager-step1", profile ? "success" : "blocked",
      profile ? "Saved and matched" : "Save / refresh required");
    setState("named-manager-step2", credential ? "success" : "blocked",
      credential ? "Native credential verified" : "Credential not verified");
    setState("named-manager-step3", anchor && owner ? "success" : "warning",
      anchor && owner ? "Anchor + owner verified" : "Independent owners not verified");
    setState("named-manager-step4", connector && edge ? "success" : "warning",
      connector && edge ? "Connector + OAuth challenge observed" : "Live edge not verified");
    setState("named-manager-step5", oauth && gemini && edge ? "review" : "blocked",
      oauth && gemini && edge ? "Evidence available · operator review" : "OAuth / Gemini verification required");
    setText("named-manager-anchor", anchor ? "Verified local" : "Unverified / not running");
    setText("named-manager-owner", owner ? "Verified local" : "Unverified / not running");
    setText("named-manager-connector", connector ? "Verified local" : "Unverified / not running");
    setText("named-manager-edge", edge ? "HTTP " + String(h.edgeHttpStatus) + " · OAuth challenge" : "Unverified / not reachable");
    setText("named-manager-oauth", oauth ? "Verified by native status" : "Not verified");
    setText("named-manager-gemini", gemini ? "Verified by native status" : "Not verified");
    setText("named-manager-profile", state.saved
      ? state.saved.hostname + " · " + state.saved.tunnelId : "No verified profile");
    const planButton = $("named-manager-plan");
    if (planButton) planButton.disabled = state.busy || !profile;
    const connectorButton = $("named-manager-start-connector");
    if (connectorButton) connectorButton.disabled = state.busy || !credential ||
      !anchor || !owner || s.connectorStatus !== "not_started" ||
      $("named-tunnel-start")?.disabled !== false;
    for (const [id, allowedNow] of [
      ["named-manager-import-clipboard",profile],
      ["named-manager-import-file",profile],
      ["named-manager-check-connector",!state.busy],
    ]) {
      const button = $(id);
      if (button) button.disabled = state.busy || !allowedNow;
    }
    const refresh = $("named-manager-refresh");
    if (refresh) refresh.disabled = state.busy;
    const review = $("named-manager-review");
    if (review) review.disabled = state.busy || !(oauth && gemini && edge) ||
      $("named-manager-ack")?.checked !== true;
    for (const action of ACTIONS) {
      const button = $(ids[action]);
      if (button) button.disabled = state.busy || !profile ||
        !allowed(state.plan, action, state.saved.tunnelId);
    }
  }
  function allowed(plan, action, tunnelId) {
    return !!(plan && plan.noRuntimeMutation === true &&
      plan.requiresNativeApproval === true &&
      plan.status?.quickTunnelUntouched === true &&
      plan.status.tunnelId === tunnelId &&
      Array.isArray(plan.availableActions) &&
      plan.availableActions.includes(action));
  }
  function invalidate(message) {
    state.plan = null;
    state.status = null;
    state.health = null;
    stepState();
    if (message) report("warning", message);
  }
  function waitForSettingsHydration(remaining) {
    // The existing Settings form independently loads native metadata.
    // Programmatic input.value hydration does not emit an input event.
    if (!state.status || !state.saved || formMatchesSaved() || remaining <= 0 ||
        $("named-tunnel-id")?.value?.trim() ||
        $("named-tunnel-hostname")?.value?.trim() ||
        typeof window.setTimeout !== "function") return;
    window.setTimeout(() => {
      if (state.busy || !state.status) return;
      stepState();
      waitForSettingsHydration(remaining - 1);
    }, 150);
  }
  async function refresh() {
    if (state.busy) return;
    state.busy = true;
    state.plan = null;
    stepState();
    report("loading", "Reading native ownership and live HTTPS status (read only)…");
    try {
      const [config, status, health] = await Promise.all([
        invoke("get_named_tunnel_settings"),
        invoke("get_named_tunnel_manager_status"),
        invoke("get_named_tunnel_health").catch(() => null),
      ]);
      state.saved = savedConfig(config);
      state.status = safeStatus(status, state.saved);
      state.health = health?.quickTunnelUntouched === true &&
        health.tunnelId === state.saved?.tunnelId ? health : null;
      if (!state.status) throw Error("UNVERIFIED_OWNER_IDENTITY");
      const blockers = Array.isArray(state.status.blockers) ? state.status.blockers : [];
      const guidance = blockers.length ? " Blockers: " +
        [...new Set(blockers.map((b) => safeReason({message:String(b)})))].slice(0,3).join(" ") : "";
      report(blockers.length ? "warning" : "success",
        "Read-only status refreshed. Quick Tunnel is preserved." + guidance);
    } catch (error) {
      state.status = null;
      report("error", safeReason(error));
    } finally {
      state.busy = false;
      stepState();
      waitForSettingsHydration(8);
    }
  }
  async function planStack() {
    if (state.busy || !state.status || !formMatchesSaved()) return;
    state.busy = true;
    state.plan = null;
    stepState();
    report("loading", "Requesting an isolated, read-only native ownership plan…");
    try {
      const plan = await invoke("plan_named_tunnel_stack");
      if (!plan || plan.noRuntimeMutation !== true ||
          plan.requiresNativeApproval !== true ||
          plan.status?.quickTunnelUntouched !== true ||
          plan.status.tunnelId !== state.saved.tunnelId) {
        throw Error("OWNER_IDENTITY_UNVERIFIED");
      }
      if (!formMatchesSaved()) throw Error("STALE_FORM");
      state.plan = plan;
      const available = ACTIONS.filter((a) => allowed(plan, a, state.saved.tunnelId));
      report(available.length ? "success" : "warning",
        available.length ? "Native plan reviewed. Allowed isolated actions: " +
          available.join(", ") + ". Each action still requires your confirmation and native OS approval." :
          "Plan returned no explicitly authorized stack actions. No start/stop is permitted. Review the native readiness diagnostics.");
    } catch (error) {
      state.plan = null;
      report("error", safeReason(error));
    } finally {
      state.busy = false;
      stepState();
    }
  }
  async function stackAction(action) {
    if (state.busy || !ACTIONS.includes(action) || !state.status ||
        !formMatchesSaved() || !allowed(state.plan, action, state.saved?.tunnelId)) return;
    const tunnelId = state.saved.tunnelId;
    const text = action.startsWith("stop") ? "STOP" : "START";
    if (typeof window.confirm !== "function" || !window.confirm(
      text + " the isolated " + (action.endsWith("anchor") ? "Anchor" : "private MCP owner") +
      " for " + state.saved.hostname + " (" + tunnelId + ")?\n\n" +
      "This does NOT stop the legacy Gemini Quick Tunnel, change DNS, install services, or cut over OAuth. " +
      "Native OS authorization and owner verification are still required.")) return;
    state.busy = true;
    const button = $(ids[action]);
    if (button) button.dataset.loading = "true";
    stepState();
    report("loading", "Waiting for native owner verification and OS approval…");
    let failed = "";
    try {
      const result = await invoke("named_tunnel_stack_action", {
        action, expectedTunnelId:tunnelId, reviewed:true,
      });
      if (!result || result.quickTunnelUntouched !== true ||
          result.status?.tunnelId !== tunnelId || result.reviewed !== true) {
        throw Error("OWNER_IDENTITY_UNVERIFIED");
      }
      report("success", "Native " + action + " acknowledged. Refreshing real owner health; Quick Tunnel remains independent.");
    } catch (error) {
      failed = safeReason(error);
      report("error", failed);
    } finally {
      state.busy = false;
      state.plan = null; // every mutation invalidates the plan
      if (button) delete button.dataset.loading;
      await refresh();
      if (failed) report("error", failed + " Refreshed status is displayed above.");
      else if (!state.status) report("error",
        "Native action returned, but post-action owner identity could not be reverified. Treat outcome as uncertain.");
    }
  }
  function triggerExisting(id) {
    if (state.busy) return;
    const readonly = id === "named-tunnel-check";
    if (!readonly && (!state.status || !formMatchesSaved())) {
      report("error", "Save the current profile and refresh native readiness first.");
      return;
    }
    if (id === "named-tunnel-start" && $("named-manager-start-connector")?.disabled !== false) {
      report("error", "Connector requires a verified credential, Anchor, private owner and native health gate.");
      return;
    }
    const button = $(id);
    if (!button || button.disabled) {
      report("warning", "Legacy native control is unavailable or not ready. Complete earlier verification first.");
      return;
    }
    button.click();
    report("loading", "Native connector operation requested. Review its existing health panel and OS approval prompt.");
  }
  function review() {
    if (state.busy || $("named-manager-ack")?.checked !== true || !state.status ||
        !formMatchesSaved() || !state.status.oauthVerified || !state.status.geminiVerified ||
        state.health?.edgeObserved !== true || state.health.mcpAuthChallengeObserved !== true) return;
    report("warning", "Read-only review: record the verified HTTPS /mcp endpoint, OAuth PKCE approval and Gemini client validation. A separate authorized operator must perform cutover and rollback planning. No cutover command exists in this UI.");
  }
  function focusSettings() {
    $("named-tunnel-hostname")?.focus?.();
    $("named-tunnel-settings-form")?.scrollIntoView?.({behavior:"smooth",block:"center"});
  }
  function install() {
    if (!$("named-tunnel-manager")) return;
    state.saved = null; state.status = null; state.health = null; state.plan = null;
    stepState();
    $("named-manager-refresh")?.addEventListener("click", () => void refresh());
    $("named-manager-plan")?.addEventListener("click", () => void planStack());
    $("named-manager-configure")?.addEventListener("click", focusSettings);
    $("named-manager-import-clipboard")?.addEventListener("click",
      () => triggerExisting("named-tunnel-import-clipboard"));
    $("named-manager-import-file")?.addEventListener("click",
      () => triggerExisting("named-tunnel-import-token"));
    $("named-manager-check-connector")?.addEventListener("click",
      () => triggerExisting("named-tunnel-check"));
    $("named-manager-start-connector")?.addEventListener("click",
      () => triggerExisting("named-tunnel-start"));
    for (const action of ACTIONS)
      $(ids[action])?.addEventListener("click", () => void stackAction(action));
    $("named-manager-ack")?.addEventListener("change", stepState);
    $("named-manager-review")?.addEventListener("click", review);
    for (const id of ["named-tunnel-id", "named-tunnel-hostname",
      "named-tunnel-anchor-port", "named-tunnel-owner-port"])
      $(id)?.addEventListener("input", () => invalidate("Unsaved profile edit detected. Save and refresh before any lifecycle action."));
    window.addEventListener?.("named-tunnel-settings-changed", () => void refresh());
    window.addEventListener?.("named-tunnel-settings-refresh", () => void refresh());
    window.__TAURI__?.event?.listen?.("desktop-open-settings", () => void refresh());
    void refresh(); // native READ-ONLY commands only
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, {once:true});
  } else install();
})();
