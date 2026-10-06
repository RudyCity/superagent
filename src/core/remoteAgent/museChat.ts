import { getMuseWatcher } from "./museWatcher.js";
import type { RemoteAgentEnvelope } from "./protocol.js";

export interface SendChatResult {
  ok: boolean;
  detail: string;
}

/**
 * Sends a chat message to the currently connected Muse client over the
 * active tunnel WebSocket. Used by `/muse tunnel msg` and the tunnel ESC menu.
 * Never throws — all failures are reported in the returned result.
 */
export async function sendChatToMuse(text: string, port?: number): Promise<SendChatResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, detail: "Pesan kosong — tidak ada yang dikirim." };
  }
  const watcher = getMuseWatcher(port);
  if (!watcher) {
    return { ok: false, detail: "Tidak ada Muse watcher aktif. Jalankan `/muse tunnel start` dulu." };
  }
  try {
    const envelope: RemoteAgentEnvelope = {
      v: 1,
      kind: "chat",
      id: `chat_${Date.now()}`,
      text: trimmed,
    };
    const sent = await watcher.getTransport().sendEnvelope(envelope);
    return sent
      ? { ok: true, detail: "Pesan terkirim ke Muse." }
      : { ok: false, detail: "Tidak ada koneksi Muse aktif di tunnel ini." };
  } catch (err: any) {
    return { ok: false, detail: `Gagal mengirim pesan: ${err?.message || String(err)}` };
  }
}
