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

  // Listen for console.error messages from the main world injection
  window.addEventListener("superagent-console-error", (e) => {
    if (e.detail) {
      window.__capturedErrors.push({
        type: "console_error",
        message: e.detail.message,
        timestamp: e.detail.timestamp
      });
    }
  });

  // Inject script to wrap console.error in the main world page context
  try {
    const script = document.createElement("script");
    script.textContent = `
      (() => {
        const originalConsoleError = console.error;
        console.error = function (...args) {
          const msg = args.map(arg => {
            if (arg instanceof Error) return arg.message + (arg.stack ? "\\n" + arg.stack : "");
            return typeof arg === "object" ? JSON.stringify(arg) : String(arg);
          }).join(" ");
          
          window.dispatchEvent(new CustomEvent("superagent-console-error", {
            detail: { message: msg, timestamp: Date.now() }
          }));
          originalConsoleError.apply(console, args);
        };
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (err) {
    console.warn("[Superagent] Inline script injection for console.error wrapper was blocked or failed:", err);
  }
}

