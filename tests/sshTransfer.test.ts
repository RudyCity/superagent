import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";
import { sshProxy } from "../src/core/ssh/sshProxy.js";
import { isLocalConfigOrSessionPath, resolveFilePathFromArgs } from "../src/core/tools/pathHelpers.js";
import { transferSshFileTool } from "../src/core/tools/sshTransferTools.js";
import { getRootConfigDir } from "../src/core/config/paths.js";

describe("SSH Local Session Space & File Transfer", () => {
  const originalSessionPath = process.env.SUPERAGENT_SESSION_PATH;
  const mockSessionDir = path.join(os.tmpdir(), "superagent-mock-session");
  const mockSessionFile = path.join(mockSessionDir, "session_123.json");

  beforeEach(async () => {
    await fs.mkdir(mockSessionDir, { recursive: true });
    process.env.SUPERAGENT_SESSION_PATH = mockSessionFile;
    
    workspaceMode.setSshMode({
      host: "mock-host",
      port: 22,
      username: "mock-user",
      remoteCwd: "/mock/remote",
    });
  });

  afterEach(async () => {
    process.env.SUPERAGENT_SESSION_PATH = originalSessionPath;
    await fs.rm(mockSessionDir, { recursive: true, force: true });
    workspaceMode.setLocalMode();
    vi.restoreAllMocks();
  });

  it("should correctly identify local config and session paths", () => {
    const sessionScratchFile = path.join(mockSessionDir, "scratch", "helper.py");
    const globalConfigFile = path.join(getRootConfigDir(), "some-config.json");
    const externalFile = "/etc/passwd";

    expect(isLocalConfigOrSessionPath(sessionScratchFile)).toBe(true);
    expect(isLocalConfigOrSessionPath(globalConfigFile)).toBe(true);
    expect(isLocalConfigOrSessionPath(externalFile)).toBe(false);
  });

  it("should resolve local config/session paths locally even in SSH mode", () => {
    const sessionScratchFile = path.join(mockSessionDir, "scratch", "helper.py");
    const resolved = resolveFilePathFromArgs({ filePath: sessionScratchFile }, "/mock/local");
    
    expect(resolved?.toLowerCase().replace(/\\/g, "/")).toBe(sessionScratchFile.toLowerCase().replace(/\\/g, "/"));
  });

  it("should run transferSshFileTool upload action successfully", async () => {
    const localScratchFile = path.join(mockSessionDir, "scratch", "helper.py");
    await fs.mkdir(path.dirname(localScratchFile), { recursive: true });
    await fs.writeFile(localScratchFile, "print('hello')", "utf8");

    const uploadSpy = vi.spyOn(sshProxy, "uploadFile").mockImplementation(async () => {});

    const res = await transferSshFileTool.execute({
      action: "upload",
      localPath: localScratchFile,
      remotePath: "src/helper.py",
    }, "/mock/local");

    expect(uploadSpy).toHaveBeenCalledWith(
      expect.stringContaining("helper.py"),
      "src/helper.py"
    );
    expect(res).toContain("Successfully uploaded");
  });

  it("should run transferSshFileTool download action successfully", async () => {
    const localScratchFile = path.join(mockSessionDir, "scratch", "downloaded.py");
    const downloadSpy = vi.spyOn(sshProxy, "downloadFile").mockImplementation(async () => {});

    const res = await transferSshFileTool.execute({
      action: "download",
      localPath: localScratchFile,
      remotePath: "src/downloaded.py",
    }, "/mock/local");

    expect(downloadSpy).toHaveBeenCalledWith(
      "src/downloaded.py",
      expect.stringContaining("downloaded.py")
    );
    expect(res).toContain("Successfully downloaded");
  });
});
