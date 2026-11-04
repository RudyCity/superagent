/* Pure UI policy. Conversation text is never persisted. */
(() => {
  "use strict";
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    mode: "render",
    keepLast: 24,
    showControls: true,
    sidebarSync: true,
    sidebarInterval: 60,
  });
  const ALLOWED_KEEPS = Object.freeze([8, 16, 24, 40, 80]);
  const ALLOWED_INTERVALS = Object.freeze([30, 60, 120, 300]);

  function normalizeSettings(raw) {
    const value = raw && typeof raw === "object" ? raw : {};
    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_SETTINGS.enabled,
      mode: value.mode === "compact" ? "compact" : "render",
      keepLast: ALLOWED_KEEPS.includes(value.keepLast) ? value.keepLast : DEFAULT_SETTINGS.keepLast,
      showControls: typeof value.showControls === "boolean" ? value.showControls : DEFAULT_SETTINGS.showControls,
      sidebarSync: typeof value.sidebarSync === "boolean" ? value.sidebarSync : DEFAULT_SETTINGS.sidebarSync,
      sidebarInterval: ALLOWED_INTERVALS.includes(value.sidebarInterval)
        ? value.sidebarInterval : DEFAULT_SETTINGS.sidebarInterval,
    };
  }

  function plan(total, rawSettings, revealExtra = 0, showAll = false) {
    const settings = normalizeSettings(rawSettings);
    const count = Number.isSafeInteger(total) ? Math.max(0, total) : 0;
    const extra = Number.isSafeInteger(revealExtra) ? Math.max(0, revealExtra) : 0;
    const compact = settings.enabled && settings.mode === "compact" && !showAll;
    const hiddenCount = compact ? Math.max(0, count - settings.keepLast - extra) : 0;
    const optimizeBefore = settings.enabled ? Math.max(0, count - 4) : 0;
    return { total: count, hiddenCount, optimizedCount: Math.max(0, optimizeBefore - hiddenCount), optimizeBefore };
  }

  function normalizeSidebarChats(items) {
    const unique = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item.id !== "string" || !/^[a-z0-9-]{8,80}$/i.test(item.id) ||
          item.is_archived || item.is_temporary_chat || item.conversation_origin === "tpp") continue;
      const title = typeof item.title === "string"
        ? item.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 140) : "";
      const timestamp = Number.isFinite(Number(item.update_time)) ? Number(item.update_time) : 0;
      const entry = { id: item.id, title: title || "Untitled chat", timestamp };
      const old = unique.get(entry.id);
      if (!old || old.timestamp < entry.timestamp) unique.set(entry.id, entry);
    }
    return Array.from(unique.values()).sort((a, b) => b.timestamp - a.timestamp).slice(0, 40);
  }

  globalThis.ChatGPTLitePolicy = Object.freeze({
    DEFAULT_SETTINGS, ALLOWED_KEEPS, ALLOWED_INTERVALS,
    normalizeSettings, plan, normalizeSidebarChats,
  });
})();
