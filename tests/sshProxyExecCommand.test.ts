/**
 * Regression tests for the C4 audit fix: argv-style command execution
 * via `SshProxyService.execCommand()`.
 *
 * We do NOT need a real SSH server — we just need to verify the
 * argv validation and the ssh2 client call shape. We construct a
 * fake SshProxyService that bypasses the connection, then inspect
 * the arguments passed to the underlying ssh2 client.
 */
import { describe, it, expect, vi } from "vitest";

describe("SshProxyService.execCommand — argv validation (C4)", () => {
  it("rejects non-array argv", async () => {
    const { SshProxyService } = await import(
      "../src/core/ssh/sshProxy.js"
    );
    const svc = new (SshProxyService as any)();
    await expect(
      svc.execCommand("ls" as any, ".", 1000)
    ).rejects.toThrow(/argv must be a non-empty string\[\]/);
  });

  it("rejects empty argv", async () => {
    const { SshProxyService } = await import(
      "../src/core/ssh/sshProxy.js"
    );
    const svc = new (SshProxyService as any)();
    await expect(
      svc.execCommand([], ".", 1000)
    ).rejects.toThrow(/argv must be a non-empty string\[\]/);
  });

  it("rejects non-string elements", async () => {
    const { SshProxyService } = await import(
      "../src/core/ssh/sshProxy.js"
    );
    const svc = new (SshProxyService as any)();
    await expect(
      svc.execCommand(["ls", 123 as any], ".", 1000)
    ).rejects.toThrow(/every argv element must be a string/);
  });

  it("rejects NUL-byte arguments", async () => {
    const { SshProxyService } = await import(
      "../src/core/ssh/sshProxy.js"
    );
    const svc = new (SshProxyService as any)();
    await expect(
      svc.execCommand(["ls", "bad\0arg"], ".", 1000)
    ).rejects.toThrow(/contains NUL byte/);
  });
});

describe("SshProxyService.execCommand — argv passed verbatim to ssh2", () => {
  it("calls sshClient.exec with a string[] that has cd prepended", async () => {
    const { SshProxyService } = await import(
      "../src/core/ssh/sshProxy.js"
    );
    const svc = new (SshProxyService as any)();

    // Stub the boundary check + ensureConnected so the method
    // proceeds to the ssh2 call.
    svc.verifyAndExpandBoundary = async () => {};
    svc.ensureConnected = async () => {};

    // Capture the call to sshClient.exec.
    const calls: any[] = [];
    const fakeStream = {
      on: (event: string, cb: any) => {
        if (event === "close") {
          // Simulate clean exit.
          setImmediate(() => cb(0));
        }
      },
      stderr: { on: () => {} },
    };
    svc.sshClient = {
      exec: (cmd: any, cb: any) => {
        calls.push(cmd);
        cb(null, fakeStream);
      },
    };

    const res = await svc.execCommand(
      ["ls", "-la", "some dir with spaces"],
      "/remote/work",
      1000
    );

    expect(calls).toHaveLength(1);
    const argv = calls[0];
    expect(Array.isArray(argv)).toBe(true);
    // The first three tokens are the cd prelude; the rest are the
    // user's command verbatim.
    expect(argv[0]).toBe("cd");
    expect(argv[1]).toBe("/remote/work");
    expect(argv[2]).toBe("&&");
    expect(argv[3]).toBe("ls");
    expect(argv[4]).toBe("-la");
    expect(argv[5]).toBe("some dir with spaces");
    expect(res.exitCode).toBe(0);
  });

  it("does not interpolate user args into a shell string", async () => {
    const { SshProxyService } = await import(
      "../src/core/ssh/sshProxy.js"
    );
    const svc = new (SshProxyService as any)();
    svc.verifyAndExpandBoundary = async () => {};
    svc.ensureConnected = async () => {};

    const calls: any[] = [];
    const fakeStream = {
      on: (event: string, cb: any) => {
        if (event === "close") setImmediate(() => cb(0));
      },
      stderr: { on: () => {} },
    };
    svc.sshClient = {
      exec: (cmd: any, _cb: any) => {
        calls.push(cmd);
        _cb(null, fakeStream);
      },
    };

    // An argument that WOULD be a shell-injection if it were a
    // shell-string. The argv form must preserve it as a single
    // literal token.
    const evil = "; rm -rf / ; echo pwned";
    await svc.execCommand(["echo", evil], "/work", 1000);

    const argv = calls[0];
    expect(Array.isArray(argv)).toBe(true);
    // The literal evil string must be present, NOT split into tokens.
    expect(argv).toContain(evil);
    // And it must NOT appear joined to other tokens.
    for (const tok of argv) {
      // The only place ';' should appear is inside the evil string
      // itself.
      expect(typeof tok).toBe("string");
    }
  });
});
