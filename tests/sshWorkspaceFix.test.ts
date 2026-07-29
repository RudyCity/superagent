import { describe, it, expect, beforeEach } from "vitest";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";
import { sshProxy } from "../src/core/ssh/sshProxy.js";

describe("SSH Workspace Fixes — Bug Regression Suite", () => {
  beforeEach(() => {
    workspaceMode.setLocalMode();
  });

  describe("F5: parseSshTarget validation", () => {
    it("rejects empty remote path", () => {
      expect(workspaceMode.parseSshTarget("ssh://user@host:22/")).toBeNull();
    });

    it("rejects paths with double slashes", () => {
      expect(workspaceMode.parseSshTarget("ssh://user@host:22//home//ubuntu")).toBeNull();
    });

    it("rejects paths with null bytes", () => {
      expect(workspaceMode.parseSshTarget("ssh://user@host:22/home/u\0buntu")).toBeNull();
    });

    it("accepts valid ssh:// URI with port and key", () => {
      const cfg = workspaceMode.parseSshTarget(
        "ssh://ubuntu@43.134.226.18:2345/home/ubuntu?key=C:\\Users\\USER\\Downloads\\RudyNuzi.pem"
      );
      expect(cfg).not.toBeNull();
      expect(cfg!.host).toBe("43.134.226.18");
      expect(cfg!.port).toBe(2345);
      expect(cfg!.username).toBe("ubuntu");
      expect(cfg!.remoteCwd).toBe("/home/ubuntu");
      expect(cfg!.privateKeyPath).toBe("C:\\Users\\USER\\Downloads\\RudyNuzi.pem");
    });

    it("accepts user@host:/path format", () => {
      const cfg = workspaceMode.parseSshTarget("root@example.com:/var/www/app");
      expect(cfg).not.toBeNull();
      expect(cfg!.host).toBe("example.com");
      expect(cfg!.port).toBe(22);
      expect(cfg!.username).toBe("root");
      expect(cfg!.remoteCwd).toBe("/var/www/app");
    });

    it("defaults username to root when missing", () => {
      const cfg = workspaceMode.parseSshTarget("ssh://host.example.com:2222/tmp");
      expect(cfg).not.toBeNull();
      expect(cfg!.username).toBe("root");
      expect(cfg!.remoteCwd).toBe("/tmp");
    });
  });

  describe("F2: normalizePosixPath hardening", () => {
    it("handles empty / undefined target as '.'", () => {
      workspaceMode.setSshMode({
        host: "h",
        port: 22,
        username: "u",
        remoteCwd: "/home/ubuntu",
      });
      expect(sshProxy.normalizePosixPath("")).toBe("/home/ubuntu");
      expect(sshProxy.normalizePosixPath(".")).toBe("/home/ubuntu");
    });

    it("resolves relative path against remoteCwd", () => {
      workspaceMode.setSshMode({
        host: "h",
        port: 22,
        username: "u",
        remoteCwd: "/home/ubuntu",
      });
      expect(sshProxy.normalizePosixPath("docs")).toBe("/home/ubuntu/docs");
      expect(sshProxy.normalizePosixPath("docs/sub")).toBe("/home/ubuntu/docs/sub");
    });

    it("handles .. segments", () => {
      workspaceMode.setSshMode({
        host: "h",
        port: 22,
        username: "u",
        remoteCwd: "/home/ubuntu",
      });
      // .. within boundary: /home/ubuntu/docs/../notes → /home/ubuntu/notes
      expect(sshProxy.normalizePosixPath("docs/../notes")).toBe("/home/ubuntu/notes");
    });

    it("strips trailing slash from remoteCwd base", () => {
      workspaceMode.setSshMode({
        host: "h",
        port: 22,
        username: "u",
        remoteCwd: "/home/ubuntu/",
      });
      expect(sshProxy.normalizePosixPath(".")).toBe("/home/ubuntu");
      expect(sshProxy.normalizePosixPath("docs")).toBe("/home/ubuntu/docs");
    });

    it("escaping remoteCwd boundary throws", () => {
      workspaceMode.setSshMode({
        host: "h",
        port: 22,
        username: "u",
        remoteCwd: "/home/ubuntu",
      });
      expect(() => sshProxy.normalizePosixPath("/etc/passwd")).toThrow(
        /escapes remote workspace boundary/
      );
    });

    it("absolute path equal to remoteCwd is allowed", () => {
      workspaceMode.setSshMode({
        host: "h",
        port: 22,
        username: "u",
        remoteCwd: "/home/ubuntu",
      });
      expect(sshProxy.normalizePosixPath("/home/ubuntu")).toBe("/home/ubuntu");
    });
  });

  describe("F1: exec() error handler ordering (unit logic)", () => {
    it("diagnose() returns ok=false when not connected (no silent success)", async () => {
      workspaceMode.setLocalMode();
      const result = await sshProxy.diagnose();
      expect(result.ok).toBe(false);
      // Error message must NOT be empty — that would be the silent-success regression
      if (!result.ok) {
        expect(result.error.length).toBeGreaterThan(0);
      }
    });
  });

  describe("F8/F9: sshGlob/Grep tool silent-failure fix", () => {
    it("sshGlobToolExecute surfaces error when exec() returns exitCode -1 (no silent success)", async () => {
      const origExec = sshProxy.exec.bind(sshProxy);
      // Simulate a stream-error failure: empty stdout + exitCode -1 (the new F1 behavior)
      sshProxy.exec = (async () => ({ stdout: "", stderr: "[stream error] connect ETIMEDOUT", exitCode: -1 })) as any;
      try {
        const { sshGlobToolExecute } = await import("../src/core/ssh/sshCommands.js");
        const result = await sshGlobToolExecute("**/*.ts");
        // Before fix: returned "No files found matching pattern." (silent success)
        // After fix: returns error string
        expect(result).toMatch(/^Error running remote SSH glob:/);
        expect(result).not.toMatch(/No files found/);
        expect(result).toContain("connect ETIMEDOUT");
      } finally {
        sshProxy.exec = origExec;
      }
    });

    it("sshGrepToolExecute surfaces error when exec() returns exitCode -1 (no silent success)", async () => {
      const origExec = sshProxy.exec.bind(sshProxy);
      sshProxy.exec = (async () => ({ stdout: "", stderr: "[stream error] ECONNRESET", exitCode: -1 })) as any;
      try {
        const { sshGrepToolExecute } = await import("../src/core/ssh/sshCommands.js");
        const result = await sshGrepToolExecute("TODO");
        // Before fix: returned "No matches found." (silent success)
        // After fix: returns error string
        expect(result).toMatch(/^Error running remote SSH grep:/);
        expect(result).not.toMatch(/No matches found/);
        expect(result).toContain("ECONNRESET");
      } finally {
        sshProxy.exec = origExec;
      }
    });

    it("sshGrepToolExecute returns matches when exec() succeeds with stdout", async () => {
      const origExec = sshProxy.exec.bind(sshProxy);
      sshProxy.exec = (async () => ({
        stdout: "src/app.tsx:42:  // TODO: refactor this\n",
        stderr: "",
        exitCode: 0,
      })) as any;
      try {
        const { sshGrepToolExecute } = await import("../src/core/ssh/sshCommands.js");
        const result = await sshGrepToolExecute("TODO");
        expect(result).toBe("src/app.tsx:42:  // TODO: refactor this\n");
        expect(result).not.toMatch(/^Error/);
      } finally {
        sshProxy.exec = origExec;
      }
    });

    it("sshGlobToolExecute returns empty-message when exec() succeeds with empty stdout (real 'no files')", async () => {
      const origExec = sshProxy.exec.bind(sshProxy);
      sshProxy.exec = (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as any;
      try {
        const { sshGlobToolExecute } = await import("../src/core/ssh/sshCommands.js");
        const result = await sshGlobToolExecute("**/*.nonexistent");
        expect(result).toBe("No files found matching pattern.");
      } finally {
        sshProxy.exec = origExec;
      }
    });
  });

  describe("G1+G3: dynamicHooks executeHookCommand SSH routing", () => {
    it("routes to sshProxy.exec when isSsh() returns true (no local execa fallback)", async () => {
      const { workspaceMode } = await import("../src/core/ssh/workspaceMode.js");
      const { sshProxy } = await import("../src/core/ssh/sshProxy.js");
      const { executeHookCommand } = await import("../src/core/tools/dynamicHooks.js");

      const origExec = sshProxy.exec.bind(sshProxy);
      const origMode = workspaceMode.getConfig();

      workspaceMode.setSshMode({
        host: "test-host",
        port: 22,
        username: "test-user",
        remoteCwd: "/home/ubuntu",
      });

      sshProxy.exec = (async (_cmd: string, cwd: string) => {
        // Verify the hook command was sent to the REMOTE cwd, not local cwd
        expect(cwd).toBe("/home/ubuntu");
        return { stdout: "remote-hook-output", stderr: "", exitCode: 0 };
      }) as any;

      try {
        const result = await executeHookCommand(
          "make test",
          "/local/path/to/cwd", // intentionally wrong — should NOT be used in SSH mode
          undefined,
          undefined,
          60000
        );
        expect(result.stdout).toBe("remote-hook-output");
        expect(result.exitCode).toBe(0);
      } finally {
        sshProxy.exec = origExec;
        // Restore mode
        if (origMode) workspaceMode.setSshMode(origMode);
        else workspaceMode.setLocalMode();
      }
    });

    it("propagates SSH failure exitCode to caller (no silent success)", async () => {
      const { workspaceMode } = await import("../src/core/ssh/workspaceMode.js");
      const { sshProxy } = await import("../src/core/ssh/sshProxy.js");
      const { executeHookCommand } = await import("../src/core/tools/dynamicHooks.js");

      const origExec = sshProxy.exec.bind(sshProxy);
      const origMode = workspaceMode.getConfig();

      workspaceMode.setSshMode({
        host: "test-host",
        port: 22,
        username: "test-user",
        remoteCwd: "/home/ubuntu",
      });

      sshProxy.exec = (async () => ({
        stdout: "",
        stderr: "make: *** No rule to make target 'test'. Stop.",
        exitCode: -1, // SSH stream error after F1 fix
      })) as any;

      try {
        const result = await executeHookCommand(
          "make test",
          "/local/cwd",
          undefined,
          undefined,
          60000
        );
        // The hook runner should NOT mask the failure as success
        expect(result.exitCode).toBe(-1);
        expect(result.stderr).toContain("No rule to make target");
      } finally {
        sshProxy.exec = origExec;
        if (origMode) workspaceMode.setSshMode(origMode);
        else workspaceMode.setLocalMode();
      }
    });
  });
});