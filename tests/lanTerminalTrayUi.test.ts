import { describe, expect, it } from "vitest";
import fs from "node:fs";

const root = "apps/superagent-tray/ui/";
const html = fs.readFileSync(root + "index.html", "utf8");
const js = fs.readFileSync(root + "lan-terminal-task.js", "utf8");
const css = fs.readFileSync(root + "lan-devices.css", "utf8");
const rust = fs.readFileSync("apps/superagent-tray/src-tauri/src/main.rs", "utf8");

describe("Attended Windows LAN terminal task Tray", () => {
  it("mounts a separate responsive terminal task panel with functional controls", () => {
    expect(html).toContain('<script src="./lan-terminal-task.js" defer></script>');
    for (const id of [
      "lan-terminal-task-panel", "lan-terminal-task-start", "lan-terminal-task-refresh",
      "lan-terminal-task-stop", "lan-terminal-task-input", "lan-terminal-task-send",
      "lan-terminal-task-output", "lan-terminal-task-status", "lan-terminal-task-newline",
    ]) expect(html).toContain('id="' + id + '"');
    expect(css).toContain(".lan-terminal-task-head");
    expect(css).toContain("@media (max-width: 570px)");
  });

  it("uses only fixed native LAN actions, no tokens or arbitrary network URLs", () => {
    expect(js).toContain('fn("lan_support_action", { action, payload })');
    for (const operation of ["terminal_start", "terminal_read", "terminal_input", "terminal_stop"]) {
      expect(js).toContain('"' + operation + '"');
      expect(rust).toContain('"' + operation + '"');
    }
    expect(js).toContain("if (revision === mutationRevision)");
    expect(js).toContain("snapshot.truncated");
    expect(js).toContain("slice(-65_536)");
    expect(js).not.toContain("sessionToken");
    expect(js).not.toContain("pairToken");
  });
});
