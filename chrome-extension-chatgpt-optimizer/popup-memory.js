/* Explicit opt-in RAM saver. No implicit tab discarding on popup open. */
(() => {
  "use strict";
  const scope = "chatgpt-optimizer-memory-v1";
  const button = document.getElementById("sleep-background-tabs");
  const count = document.getElementById("sleep-tab-count");
  const result = document.getElementById("sleep-result");
  if (!button || !count || !result) return;
  let busy = false;
  const send = async (action) => chrome.runtime.sendMessage({ scope, action });
  function explainReasons(reasons) {
    return Object.entries(reasons || {})
      .slice(0, 3)
      .map(([reason, n]) => `${n}× ${reason}`)
      .join(" · ");
  }
  async function readStatus() {
    if (busy) return;
    try {
      const response = await send("status");
      if (!response?.ok) throw Error("Status unavailable");
      count.textContent = `${response.backgroundCount} tab latar belakang kandidat; ${response.sleepingCount} tab sudah tidur.`;
      button.disabled = response.backgroundCount === 0;
    } catch {
      count.textContent = "Tidak bisa memeriksa tab ChatGPT latar belakang.";
      button.disabled = true;
    }
  }
  async function sleepNow() {
    if (busy) return;
    busy = true;
    button.disabled = true;
    result.textContent = "Memeriksa keamanan setiap tab lalu meminta Chrome menidurkannya…";
    try {
      const response = await send("sleep_others");
      if (!response?.ok) {
        result.textContent = response?.reason || "Gagal menidurkan tab.";
        return;
      }
      result.textContent = `${response.sleeping} tab berhasil ditidurkan; ${response.skipped} dilewati; ${response.failed} gagal.` +
        (Object.keys(response.reasons || {}).length
          ? " Alasan: " + explainReasons(response.reasons) : "") +
        " Penghematan RAM tergantung Chrome dan tidak diukur dalam MB.";
    } catch {
      result.textContent = "Tidak dapat menghubungi pengelola memori ekstensi.";
    } finally {
      busy = false;
      await readStatus();
    }
  }
  button.addEventListener("click", () => { void sleepNow(); });
  void readStatus();
})();
