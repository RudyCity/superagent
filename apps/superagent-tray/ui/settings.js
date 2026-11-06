"use strict";

/**
 * Tray preferences are a fixed native schema, not browser localStorage.
 * No Core auth, MCP credentials, arbitrary paths or subprocess options.
 */
const traySettingsDefault = Object.freeze({
  version: 1,
  autoLaunchWithSuperagent: true,
  notificationsEnabled: true,
  closeToTray: true,
  runtimeScanSeconds: 20,
  jobsRefreshSeconds: 30,
  notificationPollSeconds: 15,
  startupPage: "jobs",
});

const traySettingFields = {
  autoLaunchWithSuperagent: "settings-auto-launch",
  notificationsEnabled: "settings-notifications",
  closeToTray: "settings-close-to-tray",
  runtimeScanSeconds: "settings-runtime-scan",
  jobsRefreshSeconds: "settings-jobs-refresh",
  notificationPollSeconds: "settings-notification-poll",
  startupPage: "settings-startup-page",
};

let traySettingsBusy = false;
let traySettingsInitialized = false;
const traySettingsElement = (id) => document.getElementById(id);
const traySettingsInvoke = (name, data) => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error("SuperAgent Tray requires the native desktop runtime");
  return invoke(name, data);
};

function traySettingsValidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Tray settings");
  }
  const required = Object.keys(traySettingsDefault).sort();
  const actual = Object.keys(value).sort();
  if (required.length !== actual.length ||
      required.some((key, i) => key !== actual[i])) {
    throw new Error("Unexpected or missing Tray settings field");
  }
  if (value.version !== 1 ||
      ["autoLaunchWithSuperagent", "notificationsEnabled", "closeToTray"]
        .some((field) => typeof value[field] !== "boolean") ||
      ![10,20,30,60,120].includes(value.runtimeScanSeconds) ||
      ![15,30,60,120].includes(value.jobsRefreshSeconds) ||
      ![15,30,60,120].includes(value.notificationPollSeconds) ||
      !["jobs","runtime","history","logs","delegate","terminal","muse-files","lan-devices"].includes(value.startupPage)) {
    throw new Error("Tray settings contain an unsupported value");
  }
  return value;
}

function traySettingsDisplay(value) {
  const s = traySettingsValidate(value);
  for (const [key, id] of Object.entries(traySettingFields)) {
    const element = traySettingsElement(id);
    if (!element) continue;
    if (typeof s[key] === "boolean") element.checked = s[key];
    else element.value = String(s[key]);
  }
}

function traySettingsReadForm() {
  const get = (key) => traySettingsElement(traySettingFields[key]);
  return traySettingsValidate({
    version: 1,
    autoLaunchWithSuperagent: get("autoLaunchWithSuperagent").checked === true,
    notificationsEnabled: get("notificationsEnabled").checked === true,
    closeToTray: get("closeToTray").checked === true,
    runtimeScanSeconds: Number(get("runtimeScanSeconds").value),
    jobsRefreshSeconds: Number(get("jobsRefreshSeconds").value),
    notificationPollSeconds: Number(get("notificationPollSeconds").value),
    startupPage: String(get("startupPage").value),
  });
}

function traySettingsApplied(settings) {
  const validated = traySettingsValidate(settings);
  // Dispatch only bounded, validated non-secret settings values.
  window.__superagentTraySettings = { ...validated };
  window.dispatchEvent(new CustomEvent("tray-settings-changed", {
    detail: { ...validated },
  }));
}

async function traySettingsLoad(initial = false) {
  if (traySettingsBusy) return;
  const feedback = traySettingsElement("settings-feedback");
  try {
    const settings = traySettingsValidate(await traySettingsInvoke("get_tray_settings"));
    traySettingsDisplay(settings);
    traySettingsApplied(settings);
    if (initial && !window.__superagentTrayHadInitialHash &&
        typeof window.navigateToPage === "function") {
      window.navigateToPage(settings.startupPage);
    }
    traySettingsInitialized = true;
    if (feedback) feedback.textContent = "";
  } catch (error) {
    if (feedback) feedback.textContent =
      "Cannot read Tray preferences: " + String(error) +
      ". Use Restore Defaults then Save to repair a corrupt settings file.";
  }
}

async function traySettingsSave(event) {
  event?.preventDefault?.();
  if (traySettingsBusy) return;
  const button = traySettingsElement("settings-save");
  const feedback = traySettingsElement("settings-feedback");
  traySettingsBusy = true;
  if (button) button.disabled = true;
  try {
    const payload = traySettingsReadForm();
    const saved = traySettingsValidate(
      await traySettingsInvoke("set_tray_settings", {settings:payload})
    );
    traySettingsDisplay(saved);
    traySettingsApplied(saved);
    if (feedback) feedback.textContent =
      "Settings saved. Runtime and schedules refresh intervals updated. " +
      "Auto-launch applies to the next SuperAgent startup; startup page applies to the next window.";
  } catch (error) {
    if (feedback) feedback.textContent = "Settings NOT saved: " + String(error);
  } finally {
    traySettingsBusy = false;
    if (button) button.disabled = false;
  }
}

function traySettingsRestoreDefaults() {
  if (traySettingsBusy) return;
  traySettingsDisplay(traySettingsDefault);
  const feedback = traySettingsElement("settings-feedback");
  if (feedback) feedback.textContent = "Defaults loaded into the form. Press Save Settings to apply them.";
}

let museTelegramBusy = false;
let museSettingsWorkspaces = [];
let museSettingsLastView = null;

function museSettingsEscape(value) {
  return String(value ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function museSettingsRenderWorkspaces(defaultWorkspace = "") {
  const list=traySettingsElement("muse-workspace-list");
  const def=traySettingsElement("muse-default-workspace");
  const options=museSettingsWorkspaces.map((workspace,index)=>
    `<option value="${index}">${museSettingsEscape(workspace)}</option>`).join("");
  if(list) list.innerHTML=options;
  if(def) {
    def.innerHTML=museSettingsWorkspaces.map(workspace=>
      `<option value="${museSettingsEscape(workspace)}">${museSettingsEscape(workspace)}</option>`).join("");
    if(defaultWorkspace && museSettingsWorkspaces.includes(defaultWorkspace)) {
      def.value=defaultWorkspace;
    } else if(museSettingsWorkspaces[0]) {
      def.value=museSettingsWorkspaces[0];
    }
  }
}

function museTelegramDisplay(view) {
  museSettingsLastView=view||null;
  const status=traySettingsElement("muse-telegram-status");
  const token=traySettingsElement("muse-telegram-bot-token");
  const tokenHint=traySettingsElement("muse-telegram-token-hint");
  const group=traySettingsElement("muse-telegram-group-id");
  const museBot=traySettingsElement("muse-telegram-bot-id");
  const clear=traySettingsElement("muse-telegram-clear-token");
  const storage=traySettingsElement("muse-token-storage");
  const wsPort=traySettingsElement("muse-ws-port");
  const wsPath=traySettingsElement("muse-ws-path");
  const wsMode=traySettingsElement("muse-ws-mode");
  const wsRemote=traySettingsElement("muse-ws-remote-url");
  const wsTokenStatus=traySettingsElement("muse-ws-token-status");
  const autoStart=traySettingsElement("muse-auto-start");
  const stale=traySettingsElement("muse-config-stale");
  const apply=traySettingsElement("muse-apply-restart");

  if(token) token.value="";
  if(group) group.value=String(view?.groupId||"");
  if(museBot) museBot.value=String(view?.museBotId||"");
  if(clear) clear.checked=false;

  museSettingsWorkspaces=Array.isArray(view?.workspaces) ? [...view.workspaces] : [];
  museSettingsRenderWorkspaces(String(view?.defaultWorkspace||""));

  if(wsPort) wsPort.value=String(view?.wsPort||9225);
  if(wsPath) wsPath.value=String(view?.wsPath||"/muse");
  if(wsMode) wsMode.value=String(view?.wsMode||"server");
  if(wsRemote) wsRemote.value=String(view?.wsRemoteUrl||"");
  if(autoStart) autoStart.value=String(view?.autoStartMode||"off");

  const ready=view?.ready===true;
  if(status) status.textContent=view?.configStale ? "Running · settings stale" :
    view?.watcherActive ? "Running" : ready ? "Ready" : "Incomplete";

  if(tokenHint) tokenHint.textContent=view?.tokenConfigured
    ? "Token configured ("+String(view.tokenMask||"masked")+"). Leave blank to keep it; the saved token is never returned to this UI."
    : "No bot token configured. Enter a Telegram Bot API token before starting Muse in Telegram mode.";

  if(storage) {
    const storageLabel=view?.tokenStorage==="dpapi-current-user"
      ? "DPAPI CurrentUser"
      : view?.tokenStorage==="file-0600"
        ? "owner-only file fallback"
        : view?.tokenStorage==="legacy-plaintext"
          ? "legacy plaintext — Save Muse Settings to migrate"
          : "not configured";
    storage.textContent="Credential storage: "+storageLabel+
      (view?.tokenPlatformProtected ? " · OS protected" : "");
  }
  if(wsTokenStatus) wsTokenStatus.textContent=
    "WebSocket token: "+(view?.wsTokenConfigured ? "configured" : "not configured");
  if(stale) stale.textContent=view?.configStale
    ? "Runtime configuration: STALE — saved settings differ from the running watcher."
    : view?.watcherActive
      ? "Runtime configuration: current."
      : "Runtime configuration: watcher not running.";
  if(apply) apply.disabled=view?.configStale!==true;
}

async function museTelegramLoad() {
  if (museTelegramBusy) return;
  const feedback=traySettingsElement("muse-telegram-feedback");
  try {
    const result=await traySettingsInvoke("get_muse_telegram_settings");
    if (result?.success!==true || !result.settings) {
      throw new Error("Core did not return Muse settings");
    }
    museTelegramDisplay(result.settings);
    if (feedback) feedback.textContent="";
  } catch (error) {
    const status=traySettingsElement("muse-telegram-status");
    if (status) status.textContent="Core unavailable";
    if (feedback) feedback.textContent="Cannot read Muse settings: "+String(error);
  }
}

function museWorkspaceAdd() {
  const input=traySettingsElement("muse-workspace-input");
  const value=String(input?.value||"").trim();
  if(!value) return;
  const key=value.toLowerCase();
  if(!museSettingsWorkspaces.some(item=>item.toLowerCase()===key)) {
    museSettingsWorkspaces.push(value);
  }
  if(input) input.value="";
  museSettingsRenderWorkspaces(
    String(traySettingsElement("muse-default-workspace")?.value||museSettingsWorkspaces[0]||"")
  );
}

function museWorkspaceRemove() {
  const list=traySettingsElement("muse-workspace-list");
  const index=Number(list?.value);
  if(!Number.isInteger(index)||index<0||index>=museSettingsWorkspaces.length) return;
  const previousDefault=String(traySettingsElement("muse-default-workspace")?.value||"");
  museSettingsWorkspaces.splice(index,1);
  museSettingsRenderWorkspaces(previousDefault);
}

function museTelegramReadForm() {
  const botToken=String(traySettingsElement("muse-telegram-bot-token")?.value||"").trim();
  const groupId=String(traySettingsElement("muse-telegram-group-id")?.value||"").trim();
  const museBotId=String(traySettingsElement("muse-telegram-bot-id")?.value||"").trim();
  const clearBotToken=traySettingsElement("muse-telegram-clear-token")?.checked===true;
  const defaultWorkspace=String(traySettingsElement("muse-default-workspace")?.value||"").trim();
  const wsPort=Number(traySettingsElement("muse-ws-port")?.value);
  const wsPath=String(traySettingsElement("muse-ws-path")?.value||"/muse").trim();
  const wsMode=String(traySettingsElement("muse-ws-mode")?.value||"server");
  const wsRemoteUrl=String(traySettingsElement("muse-ws-remote-url")?.value||"").trim();
  const autoStartMode=String(traySettingsElement("muse-auto-start")?.value||"off");

  if (botToken && (botToken.length>256 || /\s/.test(botToken))) throw new Error("Bot token is malformed");
  if (groupId && !/^-?[0-9]{1,20}$/.test(groupId)) throw new Error("Group ID must be numeric");
  if (museBotId && !/^[0-9]{1,20}$/.test(museBotId)) throw new Error("Muse Bot ID must be numeric");
  if (clearBotToken && botToken) throw new Error("Choose replacement token or Clear saved Bot Token, not both");
  if (!museSettingsWorkspaces.length) throw new Error("Add at least one watched workspace");
  if (!defaultWorkspace || !museSettingsWorkspaces.includes(defaultWorkspace))
    throw new Error("Choose a default workspace from the watched list");
  if (!Number.isSafeInteger(wsPort)||wsPort<1024||wsPort>65535)
    throw new Error("WebSocket port is invalid");
  if (!/^\/[A-Za-z0-9/_-]*$/.test(wsPath)||wsPath.includes("//"))
    throw new Error("WebSocket path is invalid");
  if (!["server","client"].includes(wsMode)) throw new Error("WebSocket mode is invalid");
  if (wsMode==="client" && !/^wss?:\/\//i.test(wsRemoteUrl))
    throw new Error("Client mode requires a ws:// or wss:// remote URL");
  if (!["off","telegram","websocket"].includes(autoStartMode))
    throw new Error("Auto-start mode is invalid");

  return {
    botToken,groupId,museBotId,clearBotToken,
    workspaces:[...museSettingsWorkspaces],defaultWorkspace,
    wsPort,wsPath,wsMode,wsRemoteUrl,autoStartMode,
  };
}

async function museTelegramSave(event) {
  event?.preventDefault?.();
  if (museTelegramBusy) return;
  const button=traySettingsElement("muse-telegram-save");
  const feedback=traySettingsElement("muse-telegram-feedback");
  museTelegramBusy=true;
  if (button) button.disabled=true;
  try {
    const settings=museTelegramReadForm();
    const result=await traySettingsInvoke("set_muse_telegram_settings",{settings});
    if (result?.success!==true || !result.settings) throw new Error("Core did not confirm Muse settings");
    museTelegramDisplay(result.settings);
    if (feedback) feedback.textContent=result.settings.configStale
      ? "Muse settings saved. Running watcher is stale; use Apply & Restart Muse when no batch is active."
      : "Muse settings saved.";
  } catch (error) {
    if (feedback) feedback.textContent="Muse settings NOT saved: "+String(error);
  } finally {
    museTelegramBusy=false;
    if (button) button.disabled=false;
  }
}

async function museTelegramTest() {
  if (museTelegramBusy) return;
  const button=traySettingsElement("muse-telegram-test");
  const feedback=traySettingsElement("muse-telegram-feedback");
  const results=traySettingsElement("muse-telegram-doctor");
  museTelegramBusy=true;
  if (button) button.disabled=true;
  if (feedback) feedback.textContent="Running Telegram Doctor…";
  try {
    const result=await traySettingsInvoke("test_muse_telegram_settings");
    const test=result?.test;
    if (!test) throw new Error("Core did not return a Telegram Doctor result");
    if(results) {
      const checks=Array.isArray(test.checks)?test.checks:[];
      results.innerHTML=checks.map(item=>"<div>"+museSettingsEscape(item)+"</div>").join("");
      results.hidden=false;
    }
    const identity=test.username ? "@"+test.username : test.firstName || "configured bot";
    if (feedback) feedback.textContent=(test.botOnline ? "Telegram Bot API online ("+identity+"). " : "")+test.message;
  } catch (error) {
    if (feedback) feedback.textContent="Telegram Doctor failed: "+String(error);
  } finally {
    museTelegramBusy=false;
    if (button) button.disabled=false;
  }
}

async function museWsRegenerateToken() {
  if(museTelegramBusy) return;
  const button=traySettingsElement("muse-ws-token-regenerate");
  const feedback=traySettingsElement("muse-telegram-feedback");
  museTelegramBusy=true;
  if(button) button.disabled=true;
  try {
    const result=await traySettingsInvoke("regenerate_muse_ws_token");
    if(result?.success!==true) throw new Error("Core did not confirm WebSocket token generation");
    if(result.settings) museTelegramDisplay(result.settings);
    if(feedback) feedback.textContent=String(result.message||"Muse WebSocket token generated.");
  } catch(error) {
    if(feedback) feedback.textContent="WebSocket token was not changed: "+String(error);
  } finally {
    museTelegramBusy=false;
    if(button) button.disabled=false;
  }
}

async function museApplyRestart() {
  if(museTelegramBusy || museSettingsLastView?.configStale!==true) return;
  if(typeof window.confirm==="function" &&
     !window.confirm("Apply the saved Muse settings and restart the idle watcher? Active or queued batches will block this operation. Public tunnel owners are never restarted here.")) return;
  const button=traySettingsElement("muse-apply-restart");
  const feedback=traySettingsElement("muse-telegram-feedback");
  museTelegramBusy=true;
  if(button) button.disabled=true;
  try {
    const result=await traySettingsInvoke("apply_muse_settings");
    if(result?.success!==true) throw new Error("Core did not confirm Muse restart");
    if(feedback) feedback.textContent=String(result.message||"Muse settings applied and watcher restarted.");
    await museTelegramLoad();
  } catch(error) {
    if(feedback) feedback.textContent="Apply & Restart rejected or not verified: "+String(error);
  } finally {
    museTelegramBusy=false;
  }
}

function traySettingsInstall() {
  traySettingsElement("tray-settings-form")?.addEventListener("submit", traySettingsSave);
  traySettingsElement("settings-defaults")?.addEventListener("click", traySettingsRestoreDefaults);
  traySettingsElement("muse-telegram-settings-form")?.addEventListener("submit", museTelegramSave);
  traySettingsElement("muse-telegram-test")?.addEventListener("click", museTelegramTest);
  traySettingsElement("muse-workspace-add")?.addEventListener("click", museWorkspaceAdd);
  traySettingsElement("muse-workspace-remove")?.addEventListener("click", museWorkspaceRemove);
  traySettingsElement("muse-ws-token-regenerate")?.addEventListener("click", museWsRegenerateToken);
  traySettingsElement("muse-apply-restart")?.addEventListener("click", museApplyRestart);
  window.__TAURI__?.event?.listen?.("desktop-open-settings", () => {
    if (typeof window.navigateToPage === "function") window.navigateToPage("settings");
    void traySettingsLoad();
    void museTelegramLoad();
  });
  void traySettingsLoad(true);
  void museTelegramLoad();
}

traySettingsInstall();
