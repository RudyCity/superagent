# ChatGPT Optimizer

Ekstensi Chrome **Manifest V3**, berdiri sendiri dan khusus untuk `https://chatgpt.com/*`. Dibuat untuk mengurangi beban **rendering** pada percakapan panjang tanpa memotong chat di server, menutup tab, atau menyentuh ekstensi SuperAgent lain.

## Instalasi (Windows)

1. Buka `chrome://extensions`, aktifkan **Developer mode**.
2. Klik **Load unpacked**, lalu pilih folder:
   `D:\backup from pc asus\Documents Development\superagent\chrome-extension-chatgpt-optimizer`
3. **Reload tab ChatGPT yang sudah terbuka sekali** agar content script terpasang.
4. Pin **ChatGPT Optimizer** ke toolbar, klik ikonnya untuk membuka pengaturan.

Tidak perlu menjalankan server SuperAgent, API key, koneksi localhost, atau menjalankan build tambahan. Script ekstensi langsung siap dari folder.

## Mode

| Mode | Perilaku | Kompatibilitas |
| --- | --- | --- |
| **Render ringan (default)** | Menandai turn lama dengan CSS `content-visibility: auto` dan `contain-intrinsic-size: auto 320px`. Turn terbaru tidak disentuh. Tidak ada pesan tersembunyi. | Direkomendasikan saat **SuperAgent Delegate** aktif dan membaca history DOM. |
| **Ringkas pesan lama** | Menyembunyikan pesan lama dengan atribut dan CSS `display: none`, sambil mempertahankan **8/16/24/40/80 pesan terbaru**. Tombol **+20 pesan**, **Lihat semua** dan **Reset tampilan** tersedia. | Bisa menyembunyikan pesan lama dari pembaca DOM ekstensi lain (termasuk Delegate). Kembali ke *Render ringan* sebelum memakai pembacaan seluruh history DOM. |

**Penting:** mode Ringkas **bukan** penghapusan node DOM, message data, React state, atau history di server. Tidak ada optimasi memori JavaScript/React yang dijanjikan; pengurangan utamanya ada pada layout dan painting. Dalam mode Ringkas, pesan lama disembunyikan secara visual tetapi tetap ada pada DOM. Efek terhadap kecepatan bergantung pada panjang chat dan browser.

### Diagnostik Render ringan (v0.4.1)

Mode **Render ringan** menggunakan CSS `content-visibility: auto` untuk melewati rendering sebagian konten pesan lama yang berada di luar layar. Ini **tidak mengurangi memori React, tidak menghapus DOM dan tidak menjamin penurunan RAM/VRAM**. Mode **Ringkas pesan lama** memberi efek visual lebih besar, tetapi dapat mengganggu Delegate yang membaca semua pesan.

- Popup memverifikasi nilai CSS nyata menggunakan `getComputedStyle` pada sampel, bukan hanya jumlah atribut. Status ditampilkan bila CSS tidak aktif atau hanya aktif sebagian.
- Pemeriksaan `checkVisibility({ contentVisibilityAuto: true })` pada isi elemen dipakai untuk mengindikasikan sampel yang sedang dilewati browser; ini bukan benchmark FPS.
- Pembungkus dengan `display: contents` dialihkan ke satu anak yang memiliki layout box bila aman.
- Popup tidak memindai ulang seluruh chat tanpa perubahan; streaming token dalam turn yang sama dan perubahan di sidebar tidak memicu pemindaian penuh.
- Empat pesan terbaru tidak dioptimasi, fokus/seleksi dilindungi, dan semua atribut dibersihkan saat nonaktif atau pindah percakapan.

Uji browser terisolasi: `node chrome-extension-chatgpt-optimizer/verify-render.mjs` menjalankan Chromium headless menggunakan `playwright-core` dengan percakapan sintetis. Hasil: 56 elemen CSS aktif, 51 isi offscreen dilewati rendering, tidak ada scan tambahan saat streaming, dan semua pesan dipertahankan setelah optimasi dinonaktifkan. Belum ada benchmark FPS atau memori pada ChatGPT nyata.

### Penggunaan

- Ubah mode melalui popup; perubahan langsung diterapkan pada tab `chatgpt.com` yang terbuka.
- Saat Ringkas aktif, overlay kecil di chat menunjukkan jumlah pesan yang disembunyikan. Klik **+20 pesan** untuk menampilkan pesan yang lebih lama secara bertahap, atau **Lihat semua**.
- **Reset tampilan** mengembalikan pengaturan batas terakhir dan menyingkat kembali pesan lama.
- Matikan sakelar utama untuk melepas semua atribut optimasi dari pesan; atau nonaktifkan ekstensi di Chrome untuk memulihkan tampilan tanpa menyentuh data chat.
- Saat pindah chat, jendela tampilan sementara di-reset. Tidak ada pengaturan atau isi chat yang disimpan per percakapan.

## Penghematan RAM nyata untuk tab latar (v0.5.1)

**Render ringan** hanya mengurangi pekerjaan rendering dan tidak melepas memori React pada tab aktif. Untuk penghematan RAM saat **banyak tab ChatGPT terbuka**, gunakan tombol **Tidurkan tab ChatGPT lain** di popup.

Fitur ini menggunakan `chrome.tabs.discard(tabId)`, API Chrome untuk melepas konten tab latar dari RAM tanpa menghapus tab. Tab **dimuat ulang saat dikunjungi kembali**. Hal ini berbeda dari *Retry chat only*, yang tidak me-reload halaman. Jika ChatGPT bermasalah saat dimuat ulang, error loading masih mungkin terjadi.

Perlindungan: hanya percakapan tersimpan yang sudah dimuat; tab aktif di **semua jendela**, tab pinned, berbunyi, tidak boleh di-discard, memiliki draft, streaming AI, upload, rekaman/panggilan atau dialog akan dilewati. Status dan URL dicek ulang sebelum tidur; bila pemeriksaan tidak tersedia, tab tidak disentuh.

**Manual saja**, bukan otomatis. Jika tab lama belum memiliki skrip pemeriksa keamanan, ekstensi menyuntikkan pemeriksa baca-saja melalui `chrome.scripting.executeScript` saat tombol diklik, tanpa memuat ulang halaman; jika gagal, tab dilewati. Tidurkan hanya tab yang tidak lagi menjalankan Delegate atau tugas AI penting. Popup menampilkan jumlah tab yang benar-benar ditidurkan, dilewati atau gagal—**bukan angka MB yang belum diukur**. Memori tab aktif tidak berkurang. Tiap profil Chrome perlu ekstensi sendiri.

## Recent-chat synchronization (v0.4.0)

The extension checks saved chats from the signed-in account without refreshing the ChatGPT page or touching its React state.

- **Where:** scroll the left menu to **Recents**. A small **↻** indicator follows that heading; click it to open an isolated dropdown of chats that have not yet appeared in the built-in list. The old large bottom-left overlay is gone.
- **What updates:** the indicator shows a count of missing chats, or **!** on a failed check. Synced links open in a **new tab** to avoid replacing the current working conversation. They disappear when native Recents catches up.
- **Automatic checks:** a Manifest V3 alarm asks one ChatGPT tab per Chrome window to check periodically, including inactive windows. Default **60 seconds**; options 30, 120 and 300 seconds. Chrome may throttle or delay alarms; sync is not an instant push notification.
- **Manual checks:** use the ↻ inside the dropdown or **Check recent chats now** in the popup. Focus and initial load also trigger rate-limited checks.
- **Separate Chrome profiles:** install the extension in each profile and log into the **same account**. Each checks the first-party server independently; Chrome Sync and a SuperAgent server are not needed.
- **Safety:** no full-page reload, native sidebar mutations, message editing or chat-content storage. Special TPP-origin conversations are excluded from normal `/c/{id}` links.
- **Limitations:** unsaved empty chats may not exist in history; internal ChatGPT endpoints and DOM markup may change. Failed checks show an error and hide stale shortcuts.

**Important:** this is an *extension-owned list visually attached to Recents*, **not** an update to ChatGPT's own React cache. Only ChatGPT controls its native sidebar list. The original working conversation is never reloaded by the sync feature.

## Retry a failed conversation in place (v0.3.3)

Use the extension popup's **Retry failed chat content** section:

1. Select a ChatGPT conversation tab visibly showing **Could not load this ChatGPT conversation**.
2. Click **Retry chat only**. The extension verifies that no draft, generation, upload or dialog is active and triggers only the native **Try again** control in that error card.
3. **No Chrome tab reload or navigation occurs.** ChatGPT's app is responsible for its own request and React state update. If the control is absent or disabled, the extension reports failure instead of falling back to a hard refresh.

**Error recovery:** On the visible ChatGPT error screen, the extension finds an enabled **Try again** button in the same error card and activates it once per click, with a 10-second cooldown. A quoted error in a chat turn is not treated as an app error. A retry does not guarantee recovery; deleted or inaccessible conversations cannot be restored this way.

In-page retry is blocked if the tab has an unsent draft, an in-progress response or upload, an open dialog, a changed URL or a page still loading. **An already-loaded chat has no supported independent in-place refresh in this extension**; replacing React's messages or restarting SSE would not safely update ChatGPT's internal state. New/unsaved chat pages and non-ChatGPT pages cannot be selected. Use **Update tab list** after opening or closing tabs.

**Independent Chrome profiles:** the extension sees only tabs belonging to the Chrome profile in which it is installed. Install ChatGPT Optimizer separately in each profile; it cannot reload a chat belonging to a different profile.

**After renaming:** Chrome may still reference the former unpacked directory. Go to `chrome://extensions`, remove the old unpacked installation and use **Load unpacked** to select the new `chrome-extension-chatgpt-optimizer` folder. The extension ID may change, which can reset per-extension settings.

## Privasi dan keamanan

- Izin terbatas pada `storage`, `tabs`, `alarms`, `scripting`, dan host `https://chatgpt.com/*`; `alarms` hanya menjadwalkan pemeriksaan background.
- Sidebar synchronization performs **read-only first-party fetches** to `/api/auth/session` and `/backend-api/conversations` on `chatgpt.com`. The access token is used in memory only to authenticate ChatGPT's history requests; it is never logged, persisted, returned to the popup, or sent to any other origin. The endpoint is not a public API and may change. No WebSocket, debugger, analytics, or external server is used.
- The new sidebar feature reads **conversation IDs and titles** to display local links. It discards message mappings, snippets, response content and token-bearing session data, and never stores chat metadata in Chrome storage; only UI settings are persisted. The message-rendering feature still stores no message text.
- Tidak mengirim/menyetop pesan, klik tombol ChatGPT, menyetel input, atau membuang node chat milik React.
- Tidak mengubah `chrome-extension/`, `chrome-extension-delegate/`, atau source kode SuperAgent.
- Pergantian route pada ChatGPT SPA dideteksi tanpa `history.pushState` monkey-patch.
- Turn yang mengandung fokus keyboard atau teks yang sedang diseleksi tidak disembunyikan.

## Verification

From the SuperAgent repository root:

```powershell
bun --bun x vitest run tests/chatgptLiteExtension.test.ts tests/chatgptOptimizerSidebar.test.ts tests/chatgptOptimizerTabReload.test.ts tests/chatgptOptimizerBackground.test.ts tests/chatgptOptimizerMemorySaver.test.ts
node --check "chrome-extension-chatgpt-optimizer/policy.js"
node --check "chrome-extension-chatgpt-optimizer/content.js"
node --check "chrome-extension-chatgpt-optimizer/sidebar.js"
node --check "chrome-extension-chatgpt-optimizer/background.js"
node --check "chrome-extension-chatgpt-optimizer/memory-worker.js"
node --check "chrome-extension-chatgpt-optimizer/tab-sleep.js"
node --check "chrome-extension-chatgpt-optimizer/popup-memory.js"
node --check "chrome-extension-chatgpt-optimizer/tab-reload.js"
node --check "chrome-extension-chatgpt-optimizer/popup.js"
node --check "chrome-extension-chatgpt-optimizer/popup-reload.js"
node chrome-extension-chatgpt-optimizer/verify-render.mjs
bun --bun x tsc --noEmit
```

Tests cover safe DOM optimization, sidebar synchronization, permissions, selected-tab isolation, reload safety checks and failures. Real-browser multi-profile and live reload acceptance still require manual validation.

**Verification boundary:** the test harness simulates extension DOM and network calls. The same-origin session+history request was separately verified in a live authenticated Chrome tab, without changing that tab. End-to-end testing with the unpacked extension installed in two real Chrome profiles is still required to certify compatibility after site updates.

## Files

- `manifest.json` — MV3 extension configuration and site-only permissions.
- `policy.js` — pure rendering and sidebar-list policies.
- `content.js` / `content.css` — render optimization with computed-style checks, layout-box fallback and structural scanning.
- `verify-render.mjs` — isolated headless Chromium rendering regression test.
- `sidebar.js` / `sidebar.css` — authenticated read-only history sync and isolated Recents-anchored shortcuts.
- `background.js` — MV3 alarm scheduler; it never receives session tokens or chat content.
- `memory-worker.js` / `tab-sleep.js` — manual Chrome tab memory release, guarded by idle-state checks.
- `popup-memory.js` — manual sleep action and result summary.
- `popup.html` / `popup.css` / `popup.js` — controls, statistics and manual sidebar refresh.
- `tab-reload.js` / `popup-reload.js` — in-page native Try again detection and guarded per-chat retry; never calls Chrome tab reload.
- `../tests/chatgptLiteExtension.test.ts` — message-rendering tests.
- `../tests/chatgptOptimizerSidebar.test.ts` — sidebar behavior, UI anchoring and safety tests.
- `../tests/chatgptOptimizerBackground.test.ts` — inactive-window scheduling and alarm tests.
- `../tests/chatgptOptimizerMemorySaver.test.ts` — inactive-tab memory-saver safety tests.
- `../tests/chatgptOptimizerTabReload.test.ts` — specific-chat reload safety and isolation tests.

Version: 0.5.1. Icons are in `icons/icon.svg` and PNG 16/32/48/128 px. Regenerate with `node "chrome-extension-chatgpt-optimizer/generate-icons.mjs"`. No external SuperAgent server is needed; a lightweight MV3 service worker schedules background checks.
