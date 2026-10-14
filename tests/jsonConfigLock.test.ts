import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execa } from "execa";

// Mock os.homedir() at the very top for full isolation
const tempHome = path.join(process.cwd(), "tests", "temp-home-lock");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);
process.env.SUPERAGENT_TEST_NO_LOCK_SUFFIX = "true";

import { getModelConfigPath, ensureGlobalConfigDir } from "../src/core/config/paths.js";
import {
  clearModelConfigCache,
  loadModelConfig,
  saveModelConfig,
  addProvider,
  getProviders
} from "../src/core/config/jsonConfig.js";

describe("jsonConfigLock", () => {
  const configPath = getModelConfigPath();
  const lockPath = configPath + ".lock";

  beforeEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    ensureGlobalConfigDir();
    clearModelConfigCache();
  });

  afterEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    clearModelConfigCache();
  });

  it("should support reentrant lock acquisition within the same process", () => {
    // 1. Initial load (acquires lock -> release)
    const config = loadModelConfig();
    expect(config).toBeDefined();

    // 2. Mutate provider (which will load then save, nesting lock calls)
    addProvider({
      id: "test-reentrant",
      name: "Reentrant Test",
      provider: "openai",
      apiKey: "sk-reentrant"
    });

    const providers = getProviders();
    const testProvider = providers.find((p) => p.id === "test-reentrant");
    expect(testProvider).toBeDefined();
    expect(testProvider?.apiKey).toBe("sk-reentrant");
  });

  it("should respect locks owned by other processes and acquire after release", async () => {
    // Write a base configuration
    const config = loadModelConfig();
    saveModelConfig(config);

    // Create a temporary script inside isolated config dir to release the lock
    const releaseScript = path.join(path.dirname(configPath), "release-lock.mjs");
    fs.writeFileSync(
      releaseScript,
      `
      import fs from 'fs';
      console.log("READY");
      setTimeout(() => {
        try {
          if (fs.existsSync(${JSON.stringify(lockPath)})) {
            fs.unlinkSync(${JSON.stringify(lockPath)});
          }
          console.log("UNLINK_SUCCESS");
        } catch (e) {
          console.error("UNLINK_ERROR: " + e.message);
          process.exit(1);
        }
      }, 220);
      `
    );

    // Spawn the background process and wait until it is running
    const child = execa("node", [releaseScript]);
    await new Promise<void>((resolve) => {
      const onData = (d: Buffer) => {
        if (d.toString().includes("READY")) {
          child.stdout?.off("data", onData);
          resolve();
        }
      };
      child.stdout?.on("data", onData);
      child.catch(() => resolve());
    });

    try {
      // Create a lock file held by the child process's real PID
      fs.writeFileSync(lockPath, `${child.pid}:0:${Date.now()}`);

      // Clear config cache to force real disk read and lock acquisition
      clearModelConfigCache();

      const startTime = Date.now();

      // loadModelConfig should block until the lock file is deleted by the child process
      const reloaded = loadModelConfig();
      const duration = Date.now() - startTime;

      expect(reloaded).toBeDefined();
      expect(duration).toBeGreaterThanOrEqual(150); // should have waited at least 150ms
      expect(fs.existsSync(lockPath)).toBe(false); // lock file should be cleaned up after loading
    } finally {
      await child.catch(() => {});
    }
  });

  it("should automatically clear and override stale locks", () => {
    // Write a stale lock file (created 10 seconds ago)
    const staleTime = Date.now() - 10000;
    fs.writeFileSync(lockPath, `99999:0:${staleTime}`);

    // Clear config cache to force real disk read and lock acquisition
    clearModelConfigCache();

    // loadModelConfig should detect it's stale, remove it, and load successfully
    const reloaded = loadModelConfig();
    expect(reloaded).toBeDefined();
    expect(fs.existsSync(lockPath)).toBe(false); // stale lock should be removed
  });

  it("should NOT destructively overwrite config file on read/parse errors if the file exists", () => {
    // 1. Write an invalid JSON string to the config file
    fs.writeFileSync(configPath, "{ invalid json: yes }", "utf-8");

    // 2. Try to load config. It should fail to parse, backup the corrupted file, and fallback
    // to default config in memory, but it MUST NOT overwrite configPath with defaults.
    const config = loadModelConfig();
    expect(config).toBeDefined();
    expect(config.providers.length).toBeGreaterThan(0); // returned in-memory fallback defaults

    // Verify the corrupted file on disk still contains the invalid content and was NOT overwritten
    const contentOnDisk = fs.readFileSync(configPath, "utf-8");
    expect(contentOnDisk).toBe("{ invalid json: yes }");

    // Verify a corrupt backup was created
    const dir = path.dirname(configPath);
    const files = fs.readdirSync(dir);
    const backupExists = files.some((f) => f.startsWith("model-config.json.corrupt-"));
    expect(backupExists).toBe(true);
  });
});
