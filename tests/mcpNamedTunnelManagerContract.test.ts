import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const native = fs.readFileSync(path.join(root,
  "apps/superagent-tray/src-tauri/src/main.rs"), "utf8");
const stack = fs.readFileSync(path.join(root,
  "apps/superagent-tray/src-tauri/src/named_tunnel_orchestrator.rs"), "utf8");

describe("Named Tunnel native IPC orchestrator contract", () => {
  it("registers all three native commands, not a webview-only mock", () => {
    for (const command of [
      "get_named_tunnel_manager_status", "plan_named_tunnel_stack",
      "named_tunnel_stack_action",
    ]) {
      expect(native).toContain("async fn " + command + "(");
      expect(native).toMatch(new RegExp("\\n\\s+" + command + ","));
    }
    expect(native).toContain("mod named_tunnel_orchestrator;");
  });

  it("requires exact user-reviewed tunnel identity and native cancellation", () => {
    expect(native).toContain("expected_tunnel_id != settings.tunnel_id");
    expect(native).toContain("if !reviewed");
    expect(native).toContain('window.label() != "main"');
    expect(native).toContain("is_focused()");
    expect(native).toContain("MessageDialogButtons::OkCancelCustom");
    expect(native).toContain("if !approved");
    expect(native).toContain("if latest != settings");
    for (const action of ["start-anchor", "start-owner", "stop-owner", "stop-anchor"]) {
      expect(stack).toContain('"' + action + '"');
    }
  });

  it("keeps active 9227 and the Quick Tunnel outside all stack actions", () => {
    expect(stack).toContain("19320");
    expect(stack).toContain("19321");
    expect(stack).toContain("9227");
    expect(stack).toContain("b2e8c6d9-9317-4d9e-b381-826af22e1778");
    expect(stack).toContain("mcp.rcity.web.id");
    expect(stack).toContain("quick_tunnel_untouched: true");
    expect(stack).toContain("ready_for_cutover: false");
    expect(stack).not.toContain("service install");
    expect(stack).not.toContain("process.kill(");
    expect(stack).not.toContain('Command::new("taskkill');
  });

  it("uses nonce+birth/executable verification, and never assumes PID is authority", () => {
    expect(stack).toContain("fn process_verified(");
    expect(stack).toContain("process.start_time()");
    expect(stack).toContain("process.exe()");
    expect(stack).toContain("bearer_auth(token)");
    expect(stack).toContain("Private lease nonce invalid");
    expect(stack).toContain('status["inFlightToolCalls"] == 0');
    expect(stack).toContain('status["activeSessions"] == 0');
    expect(stack).toContain("Another Named stack lifecycle action");
  });

  it("sanitizes spawned Anchor environment and verifies its exact Bun executable", () => {
    expect(stack).toContain("cmd.env_clear()");
    expect(stack).toContain('cmd.env("SUPERAGENT_CONFIG_DIR", dir)');
    expect(stack).toContain("fs::canonicalize(&pinned_bun)");
    expect(stack).toContain("let Ok((_, pinned_bun)) = native_runner()");
    expect(stack).toContain("if !port_unused(s.anchor_port)");
    expect(stack).toContain("child.try_wait()");
    expect(stack).toContain("child.kill()");
  });

  it("reports unsupported owner start and Anchor stop as blocked instead of fake success", () => {
    expect(stack).toContain("existing managed MCP launcher requires an authenticated IPC parent");
    expect(stack).toContain("has no authenticated graceful shutdown/drain endpoint");
    expect(stack).toContain("stop_anchor_ready = false");
    expect(stack).toContain("start_owner_ready = false");
    expect(stack).toContain("no_runtime_mutation: true");
    expect(stack).toContain("Owner accepted graceful stop but shutdown is unverified");
  });
});
