// Capture runtime errors and unhandled promise rejections
if (!window.__capturedErrors) {
  window.__capturedErrors = [];

  window.addEventListener("error", (e) => {
    window.__capturedErrors.push({
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
    window.__capturedErrors.push({
      type: "unhandled_rejection",
      message: e.reason ? (e.reason.message || String(e.reason)) : "Unknown rejection",
      stack: e.reason ? e.reason.stack : null,
      timestamp: Date.now()
    });
  });
}
