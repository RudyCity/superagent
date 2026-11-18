/**
 * Standalone diagnostic for a terminal that appears to ignore SuperAgent CLI
 * keyboard input. Does not boot agents, change settings, or log typed text.
 *
 * Run from a NEW terminal: bun run cli:input:doctor
 */
import process from "node:process";

const input = process.stdin;
const canUseRawMode = Boolean(input.isTTY && typeof input.setRawMode === "function");
console.log("SuperAgent CLI keyboard transport diagnostic");
console.log(`Bun: ${(process.versions as any).bun || "unknown"}  OS: ${process.platform}`);
console.log(`Terminal stdin: ${input.isTTY ? "TTY" : "NOT A TTY"}`);

if (!canUseRawMode) {
  console.error("FAIL: This process has no interactive TTY/raw-mode input.");
  console.error("Open a new Windows Terminal or PowerShell window, then run the CLI there.");
  process.exitCode = 2;
} else {
  const wasRaw = Boolean(input.isRaw);
  let finished = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  function finish(receivedKey: boolean): void {
    if (finished) return;
    finished = true;
    if (timeout !== undefined) clearTimeout(timeout);
    input.off("data", handleKey);
    try {
      input.setRawMode?.(wasRaw);
    } catch {}
    input.pause();
    if (receivedKey) {
      console.log("PASS: Bun received a key while terminal raw mode was active.");
      console.log("If SuperAgent still cannot type, investigate CLI focus/state rather than Windows Terminal.");
    } else {
      console.error("FAIL: No key reached Bun while the diagnostic was listening.");
      console.error("Check terminal focus/input forwarding and Windows Terminal settings.");
      process.exitCode = 1;
    }
  }

  function handleKey(data: Buffer | string): void {
    if (!data || data.length === 0) return;
    // Do NOT print the typed key; it may contain sensitive content.
    finish(true);
  }

  try {
    input.setRawMode(true);
    console.log("Press any non-sensitive key once to test input (its value is not logged).");
    input.on("data", handleKey);
    input.resume();
    timeout = setTimeout(() => finish(false), 15000);
  } catch (err) {
    console.error("FAIL: Could not enable terminal raw mode:", err instanceof Error ? err.message : String(err));
    try { input.setRawMode(wasRaw); } catch {}
    process.exitCode = 2;
  }
}
