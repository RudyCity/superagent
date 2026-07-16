// Diagnostics are injected only after explicit per-tab consent.
if (!window.__superagentDiagnosticsInstalled) {
  window.__superagentDiagnosticsInstalled = true;
  window.__capturedErrors = window.__capturedErrors || [];

  const pushCapturedError = (entry) => {
    window.__capturedErrors.push(entry);
    if (window.__capturedErrors.length > 100) {
      window.__capturedErrors.splice(0, window.__capturedErrors.length - 100);
    }
  };

  window.addEventListener("error", (e) => {
    pushCapturedError({
      type: "exception",
      message: e.message,
      source: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error ? e.error.stack : null,
      timestamp: Date.now()
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    pushCapturedError({
      type: "unhandled_rejection",
      message: e.reason ? (e.reason.message || String(e.reason)) : "Unknown rejection",
      stack: e.reason ? e.reason.stack : null,
      timestamp: Date.now()
    });
  });

  window.addEventListener("superagent-console-error", (e) => {
    if (e.detail) {
      pushCapturedError({
        type: "console_error",
        message: e.detail.message,
        timestamp: e.detail.timestamp
      });
    }
  });
}
