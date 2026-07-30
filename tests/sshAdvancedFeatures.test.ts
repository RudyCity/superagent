import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";
import { sshProxy, escapeShellArg } from "../src/core/ssh/sshProxy.js";
import { sshEvents } from "../src/core/ssh/sshEvents.js";
import { parseProxyJump, resolveHostAlias } from "../src/core/ssh/sshConfig.js";

describe("SSH Advanced Features", () => {
  beforeEach(() => {
    workspaceMode.setLocalMode();
    sshProxy.clearCache();
  });

  afterEach(() => {
    workspaceMode.setLocalMode();
    sshProxy.clearCache();
  });

  // ─── Connection State Events ───────────────────────────────────────────────

  describe("Connection state events", () => {
    it("sshEvents starts in disconnected state", () => {
      expect(sshEvents.getState()).toBe("disconnected");
    });

    it("sshEvents emits state_change events", () => {
      let received: any = null;
      sshEvents.onStateChange((data) => { received = data; });
      sshEvents.setState("connecting", { host: "test" });
      expect(received).not.toBeNull();
      expect(received.to).toBe("connecting");
      sshEvents.removeAllListeners("state_change");
    });

    it("sshEvents emits transfer_progress events", () => {
      let received: any = null;
      sshEvents.onTransferProgress((progress) => { received = progress; });
      sshEvents.emitTransferProgress({
        path: "/test/file.txt",
        direction: "upload",
        bytesTransferred: 100,
        totalBytes: 100,
        percent: 100,
      });
      expect(received).not.toBeNull();
      expect(received.direction).toBe("upload");
      sshEvents.removeAllListeners("transfer_progress");
    });

    it("sshEvents emits port_forward events", () => {
      let received: any = null;
      sshEvents.onPortForward((info) => { received = info; });
      sshEvents.emitPortForward({
        type: "local",
        localPort: 8080,
        remoteHost: "localhost",
        remotePort: 3000,
      });
      expect(received).not.toBeNull();
      expect(received.localPort).toBe(8080);
      sshEvents.removeAllListeners("port_forward");
    });

    it.skip("getConnectionState returns current state (module cache issue)", () => {
      expect(typeof sshProxy.getConnectionState).toBe("function");
    });
  });

  // ─── SSH Config File Support ───────────────────────────────────────────────

  describe("SSH config file support", () => {
    it("resolveHostAlias returns null for unknown host", () => {
      const result = resolveHostAlias("nonexistent-host-12345");
      // May return null if no ~/.ssh/config exists, or an entry if it does
      // Just verify it doesn't throw
      expect(result).toBeNull();
    });

    it("parseProxyJump parses user@host:port format", () => {
      const result = parseProxyJump("admin@bastion.example.com:2222");
      expect(result).not.toBeNull();
      expect(result!.user).toBe("admin");
      expect(result!.host).toBe("bastion.example.com");
      expect(result!.port).toBe(2222);
    });

    it("parseProxyJump parses host without port", () => {
      const result = parseProxyJump("bastion.example.com");
      expect(result).not.toBeNull();
      expect(result!.host).toBe("bastion.example.com");
      expect(result!.port).toBe(22);
      expect(result!.user).toBe("root");
    });

    it("parseProxyJump returns null for empty string", () => {
      expect(parseProxyJump("")).toBeNull();
    });
  });

  // ─── Config URL Parameters ─────────────────────────────────────────────────

  describe("Config URL parameters", () => {
    it("parses timeout parameter", () => {
      const cfg = workspaceMode.parseSshTarget("ssh://user@host:22/home/user?timeout=30000");
      expect(cfg).not.toBeNull();
      expect(cfg!.readyTimeout).toBe(30000);
    });

    it("parses compress parameter", () => {
      const cfg = workspaceMode.parseSshTarget("ssh://user@host:22/home/user?compress=yes");
      expect(cfg).not.toBeNull();
      expect(cfg!.compression).toBe(true);
    });

    it("parses agentForward parameter", () => {
      const cfg = workspaceMode.parseSshTarget("ssh://user@host:22/home/user?agentForward=yes");
      expect(cfg).not.toBeNull();
      expect(cfg!.agentForward).toBe(true);
    });

    it("parses proxyJump parameter", () => {
      const cfg = workspaceMode.parseSshTarget("ssh://user@host:22/home/user?proxyJump=admin@bastion:2222");
      expect(cfg).not.toBeNull();
      expect(cfg!.proxyJump).toBe("admin@bastion:2222");
    });

    it("parses bwlimit parameter", () => {
      const cfg = workspaceMode.parseSshTarget("ssh://user@host:22/home/user?bwlimit=102400");
      expect(cfg).not.toBeNull();
      expect(cfg!.bandwidthLimit).toBe(102400);
    });

    it("parses multiple parameters together", () => {
      const cfg = workspaceMode.parseSshTarget("ssh://user@host:22/home/user?key=/path/to/key&timeout=30000&compress=yes");
      expect(cfg).not.toBeNull();
      expect(cfg!.privateKeyPath).toBe("/path/to/key");
      expect(cfg!.readyTimeout).toBe(30000);
      expect(cfg!.compression).toBe(true);
    });
  });

  // ─── Port Forwarding ───────────────────────────────────────────────────────

  describe("Port forwarding", () => {
    it("getPortForwards returns empty array when not connected", () => {
      expect(sshProxy.getPortForwards()).toEqual([]);
    });
  });

  // ─── Shell escaping regression ─────────────────────────────────────────────

  describe("Shell escaping regression", () => {
    it("correctly escapes shell arguments", () => {
      const escaped = escapeShellArg("foo'; rm -rf / #");
      expect(escaped).toBe("'foo'\\''; rm -rf / #'");
    });

    it("escapes empty string", () => {
      expect(escapeShellArg("")).toBe("''");
    });
  });
});