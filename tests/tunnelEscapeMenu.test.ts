import { describe, expect, it } from "vitest";
import { isMuseWatcherActive } from "../src/core/remoteAgent/museWatcher.js";
import { isMuseRunnerActive } from "../src/core/remoteAgent/config.js";

describe("Tunnel ESC menu guards", () => {
  it("defaults to inactive Muse mode in standard Superagent session", () => {
    // In normal session without /muse watch or as_runner config, Muse mode is inactive
    const watcherActive = isMuseWatcherActive();
    const runnerActive = isMuseRunnerActive();
    const inMuseMode = watcherActive || runnerActive;

    expect(typeof watcherActive).toBe("boolean");
    expect(typeof runnerActive).toBe("boolean");
    // Standard mode should not be in Muse mode
    expect(inMuseMode).toBe(false);
  });
});
