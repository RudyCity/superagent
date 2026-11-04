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
      !["jobs","runtime","history","logs","delegate","terminal"].includes(value.startupPage)) {
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

function traySettingsInstall() {
  traySettingsElement("tray-settings-form")?.addEventListener("submit", traySettingsSave);
  traySettingsElement("settings-defaults")?.addEventListener("click", traySettingsRestoreDefaults);
  window.__TAURI__?.event?.listen?.("desktop-open-settings", () => {
    if (typeof window.navigateToPage === "function") window.navigateToPage("settings");
    void traySettingsLoad();
  });
  void traySettingsLoad(true);
}

traySettingsInstall();
