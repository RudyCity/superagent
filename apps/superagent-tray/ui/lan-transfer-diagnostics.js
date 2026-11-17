"use strict";
/** Private, bounded in-view transfer diagnostics. Never stores file contents or credentials. */
(() => {
  const $ = (id) => document.getElementById(id);
  const MAX = 64;
  let active = null;
  let recent = [];
  function bounded(n) { return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0; }
  function errorKind(message) {
    const text = String(message).toLowerCase();
    if (/timeout|timed out|connection|network|reset|econn|tls/.test(text)) return "network";
    if (/sha-256|checksum|digest|integrity|hash/.test(text)) return "integrity";
    if (/approval|permission|not approved|denied|revoke|expired/.test(text)) return "approval/session";
    if (/file|save|disk|space|write|storage/.test(text)) return "storage";
    if (/cancel/.test(text)) return "cancelled";
    return "unclassified";
  }
  function percentile95(samples) {
    if (!samples.length) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * 0.95) - 1];
  }
  function summary(t) {
    const elapsed = Math.max(1, Date.now() - t.startedAt) / 1000;
    const speed = t.transferred / elapsed;
    return {
      transfer: t.transfer, route: t.route, protocol: t.protocol, outcome: t.outcome,
      bytes: t.transferred, expected: t.expected, retries: t.retries,
      chunks: t.chunks, throughputKiBs: Math.round(speed / 102.4) / 10,
      rttP95Ms: bounded(percentile95(t.samples)),
      elapsedSeconds: Math.round(elapsed * 10) / 10,
      errorKind: t.errorKind,
    };
  }
  function render() {
    const el = $("lan-file-diagnostics");
    if (!el) return;
    const rows = active ? [summary(active)] : recent.slice(0, 5);
    if (!rows.length) {
      el.textContent = "No transfer telemetry yet. Diagnostics stay in this Tray view.";
      return;
    }
    el.textContent = rows.map((r) => r.transfer + " · " + r.route + " · " + r.protocol +
      " · " + r.outcome + "\n" +
      r.bytes + "/" + r.expected + " bytes · " + r.throughputKiBs + " KiB/s" +
      " · p95 " + r.rttP95Ms + " ms · " + r.retries + " recovered response(s)" +
      (r.errorKind ? " · " + r.errorKind : "")).join("\n");
  }
  function start(transfer, route, protocol, expected) {
    if (!["upload", "download", "relay"].includes(transfer) ||
        !["lan", "tunnel"].includes(route) ||
        !["v1", "v2"].includes(protocol) ||
        !Number.isSafeInteger(expected) || expected < 1 || expected > 256 * 1024 * 1024)
      throw Error("Invalid transfer telemetry metadata.");
    active = { transfer, route, protocol, expected, transferred: 0,
      samples: [], retries: 0, chunks: 0, startedAt: Date.now(),
      outcome: "running", errorKind: null };
    render();
  }
  function sample(transferred, elapsedMs, recovered = false) {
    if (!active) return;
    if (!Number.isSafeInteger(transferred) || transferred < active.transferred ||
        transferred > active.expected || !Number.isFinite(elapsedMs) ||
        elapsedMs < 0 || elapsedMs > 180_000) throw Error("Invalid transfer progress sample.");
    active.transferred = transferred;
    active.samples.push(elapsedMs);
    if (active.samples.length > MAX) active.samples.shift();
    active.chunks++;
    if (recovered) active.retries++;
    render();
  }
  function failure(error) {
    if (!active) return;
    active.outcome = "not verified";
    active.errorKind = errorKind(error);
    finish("not verified");
  }
  function finish(outcome = "verified") {
    if (!active) return;
    if (outcome !== "verified" && outcome !== "cancelled" && outcome !== "not verified")
      throw Error("Invalid transfer outcome.");
    active.outcome = outcome;
    recent.unshift(summary(active));
    if (recent.length > 5) recent = recent.slice(0, 5);
    active = null;
    render();
  }
  window.LanTransferDiagnostics = { start, sample, failure, finish };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", render, { once: true });
  else render();
})();
