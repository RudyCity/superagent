import { describe, it, expect } from "vitest";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";

describe("SSH Proxy Workspace Mode", () => {
  it("should correctly parse ssh:// URIs", () => {
    const config = workspaceMode.parseSshTarget("ssh://ubuntu@192.168.1.50:2222/var/www/app");
    expect(config).toEqual({
      host: "192.168.1.50",
      port: 2222,
      username: "ubuntu",
      remoteCwd: "/var/www/app",
    });
  });

  it("should correctly parse ssh:// URIs with custom port and private key query param", () => {
    const config = workspaceMode.parseSshTarget("ssh://ubuntu@192.168.1.50:2345/home/ubuntu?key=C:\\Users\\USER\\Downloads\\key.pem");
    expect(config).toEqual({
      host: "192.168.1.50",
      port: 2345,
      username: "ubuntu",
      privateKeyPath: "C:\\Users\\USER\\Downloads\\key.pem",
      remoteCwd: "/home/ubuntu",
    });
  });

  it("should correctly parse user@host:/path URIs", () => {
    const config = workspaceMode.parseSshTarget("root@example.com:/home/project");
    expect(config).toEqual({
      host: "example.com",
      port: 22,
      username: "root",
      remoteCwd: "/home/project",
    });
  });

  it("should return null for invalid target strings", () => {
    const config = workspaceMode.parseSshTarget("invalid-path");
    expect(config).toBeNull();
  });
});
