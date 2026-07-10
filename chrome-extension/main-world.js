(() => {
  const originalConsoleError = console.error;
  console.error = function (...args) {
    const msg = args.map(arg => {
      if (arg instanceof Error) return arg.message + (arg.stack ? "\n" + arg.stack : "");
      return typeof arg === "object" ? JSON.stringify(arg) : String(arg);
    }).join(" ");
    
    window.dispatchEvent(new CustomEvent("superagent-console-error", {
      detail: { message: msg, timestamp: Date.now() }
    }));
    originalConsoleError.apply(console, args);
  };
})();
