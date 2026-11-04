import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlashCommandContext } from "../src/core/commands/types.js";

const mock = vi.hoisted(() => ({
  starts: [] as Array<Record<string, any>>,
  active: false,
}));

vi.mock("../src/core/remoteAgent/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/core/remoteAgent/config.js")>();
  return {
    ...original,
    // A previously persisted WebSocket preference must NOT decide /muse watch start.
    loadRemoteAgentConfig: () => ({
      transport: "websocket",
      wsPort: 9225,
      workspaces: [process.cwd()],
    }),
  };
});

vi.mock("../src/core/remoteAgent/museWatcher.js", () => ({
  isMuseWatcherActive: () => mock.active,
  getMuseWatcher: () => null,
  stopMuseWatcher: vi.fn(),
  startMuseWatcher: async (options: Record<string, any>) => {
    mock.starts.push(options);
    return {
      getStats: () => ({
        isRunning: true,
        transport: options.transportType,
        museConnected: true,
      }),
    };
  },
}));

import { handleMuseWatchSubcommand } from "../src/core/commands/museWatchSubcommand.js";

describe("/muse watch default transport", () => {
  beforeEach(() => {
    mock.active = false;
    mock.starts.length = 0;
  });

  const run = async (...tokens: string[]) => {
    const lines: string[] = [];
    const ctx = {
      agent: null,
      exit: () => {},
      addLine: (line: { content: string }) => lines.push(line.content),
    } satisfies SlashCommandContext;
    await handleMuseWatchSubcommand(["watch", ...tokens], ctx, Date.now());
    return lines;
  };

  it("defaults to Telegram even when saved transport is WebSocket", async () => {
    const lines = await run("start");
    expect(mock.starts).toHaveLength(1);
    expect(mock.starts[0].transportType).toBe("telegram");
    expect(mock.starts[0].tunnel).toBe(false);
    expect(lines.join("\n")).toContain("telegram ingress ready");
  });

  it("keeps explicit WebSocket and tunnel flags working", async () => {
    await run("start", "--ws");
    expect(mock.starts[0].transportType).toBe("websocket");
    expect(mock.starts[0].tunnel).toBe(false);

    mock.starts.length = 0;
    await run("start", "--tunnel");
    expect(mock.starts[0].transportType).toBe("websocket");
    expect(mock.starts[0].tunnel).toBe(true);
  });

  it("keeps an explicit Telegram flag compatible", async () => {
    await run("start", "--telegram");
    expect(mock.starts[0].transportType).toBe("telegram");
  });

  it("reports the Telegram default while watch is inactive", async () => {
    const lines = await run("status");
    expect(lines.join("\n")).toContain("Default: Telegram");
    expect(mock.starts).toHaveLength(0);
  });
});
