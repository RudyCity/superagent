import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  watcher: null as any,
  lastPort: undefined as number | undefined,
}));

vi.mock("../src/core/remoteAgent/museWatcher.js", () => ({
  getMuseWatcher: (port?: number) => {
    state.lastPort = port;
    return state.watcher;
  },
}));

import { sendChatToMuse } from "../src/core/remoteAgent/museChat.js";

beforeEach(() => {
  state.watcher = null;
  state.lastPort = undefined;
  vi.restoreAllMocks();
});

describe("sendChatToMuse", () => {
  it("menolak pesan kosong tanpa menyentuh watcher", async () => {
    const res = await sendChatToMuse("   ");
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/kosong/i);
    expect(state.lastPort).toBeUndefined();
  });

  it("gagal jelas bila tidak ada watcher aktif", async () => {
    state.watcher = null;
    const res = await sendChatToMuse("halo");
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/watcher/i);
  });

  it("mengirim envelope chat via transport dan lapor sukses", async () => {
    const sent: any[] = [];
    state.watcher = {
      getTransport: () => ({
        sendEnvelope: async (env: any) => {
          sent.push(env);
          return true;
        },
      }),
    };
    const res = await sendChatToMuse("halo Muse");
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].v).toBe(1);
    expect(sent[0].kind).toBe("chat");
    expect(sent[0].text).toBe("halo Muse");
    expect(typeof sent[0].id).toBe("string");
  });

  it("gagal jelas bila transport tidak bisa kirim (tidak ada koneksi)", async () => {
    state.watcher = {
      getTransport: () => ({
        sendEnvelope: async () => false,
      }),
    };
    const res = await sendChatToMuse("halo");
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/koneksi/i);
  });

  it("tidak throw bila transport melempar error", async () => {
    state.watcher = {
      getTransport: () => ({
        sendEnvelope: async () => {
          throw new Error("boom");
        },
      }),
    };
    const res = await sendChatToMuse("halo");
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/boom/);
  });

  it("meneruskan port ke getMuseWatcher", async () => {
    state.watcher = {
      getTransport: () => ({ sendEnvelope: async () => true }),
    };
    const res = await sendChatToMuse("halo", 9226);
    expect(res.ok).toBe(true);
    expect(state.lastPort).toBe(9226);
  });
});
