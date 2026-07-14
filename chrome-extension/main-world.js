(() => {
  const originalConsoleError = console.error;
  console.error = function (...args) {
    let msg = "";
    try {
      msg = args.map(arg => {
        if (arg instanceof Error) {
          return arg.message + (arg.stack ? "\n" + arg.stack : "");
        }
        if (typeof arg === "object" && arg !== null) {
          try {
            return JSON.stringify(arg);
          } catch (e) {
            return String(arg);
          }
        }
        return String(arg);
      }).join(" ");
    } catch (e) {
      msg = "Error serializing console args: " + e.message;
    }
    
    try {
      window.dispatchEvent(new CustomEvent("superagent-console-error", {
        detail: { message: msg, timestamp: Date.now() }
      }));
    } catch (e) {
      // Ignore dispatcher failures to guarantee console.error never interrupts the page
    }

    try {
      originalConsoleError.apply(console, args);
    } catch (e) {
      // Ensure we don't block the original console error logic if apply fails for some reason
    }
  };
})();
