# ChatGPT Optimizer

Ekstensi Chrome **Manifest V3**, berdiri sendiri dan khusus untuk `https://chatgpt.com/*`. Dibuat untuk mengurangi beban **rendering** pada percakapan panjang tanpa memotong chat di server, menutup tab, atau menyentuh ekstensi SuperAgent lain.

## Instalasi (Windows)

1. Buka `chrome://extensions`, aktifkan **Developer mode**.
2. Klik **Load unpacked**, lalu pilih folder:
   `D:\backup from pc asus\Documents Development\superagent\chrome-extension-chatgpt-lite`
3. **Reload tab ChatGPT yang sudah terbuka sekali** agar content script terpasang.
4. Pin **ChatGPT Optimizer** ke toolbar, klik ikonnya untuk membuka pengaturan.

Tidak perlu menjalankan server SuperAgent, API key, koneksi localhost, atau menjalankan build tambahan. Script ekstensi langsung siap dari folder.

## Mode

| Mode | Perilaku | Kompatibilitas |
| --- | --- | --- |
| **Render ringan (default)** | Menandai turn lama dengan CSS `content-visibility: auto` dan `contain-intrinsic-size: auto 320px`. Turn terbaru tidak disentuh. Tidak ada pesan tersembunyi. | Direkomendasikan saat **SuperAgent Delegate** aktif dan membaca history DOM. |
| **Ringkas pesan lama** | Menyembunyikan pesan lama dengan atribut dan CSS `display: none`, sambil mempertahankan **8/16/24/40/80 pesan terbaru**. Tombol **+20 pesan**, **Lihat semua** dan **Reset tampilan** tersedia. | Bisa menyembunyikan pesan lama dari pembaca DOM ekstensi lain (termasuk Delegate). Kembali ke *Render ringan* sebelum memakai pembacaan seluruh history DOM. |

**Penting:** mode Ringkas **bukan** penghapusan node DOM, message data, React state, atau history di server. Tidak ada optimasi memori JavaScript/React yang dijanjikan; pengurangan utamanya ada pada layout dan painting. Dalam mode Ringkas, pesan lama disembunyikan secara visual tetapi tetap ada pada DOM. Efek terhadap kecepatan bergantung pada panjang chat dan browser.

### Penggunaan

- Ubah mode melalui popup; perubahan langsung diterapkan pada tab `chatgpt.com` yang terbuka.
- Saat Ringkas aktif, overlay kecil di chat menunjukkan jumlah pesan yang disembunyikan. Klik **+20 pesan** untuk menampilkan pesan yang lebih lama secara bertahap, atau **Lihat semua**.
- **Reset tampilan** mengembalikan pengaturan batas terakhir dan menyingkat kembali pesan lama.
- Matikan sakelar utama untuk melepas semua atribut optimasi dari pesan; atau nonaktifkan ekstensi di Chrome untuk memulihkan tampilan tanpa menyentuh data chat.
- Saat pindah chat, jendela tampilan sementara di-reset. Tidak ada pengaturan atau isi chat yang disimpan per percakapan.

## Recent chat synchronization (v0.2.0)

ChatGPT Optimizer checks for saved conversations from the signed-in ChatGPT account, **without reloading the active page**:

- On page load, fetch the account's first-party recent-chat listing and refresh every **60 seconds** by default; change the interval to 30, 120 or 300 seconds in the extension popup. Checks pause while the tab is hidden.
- Use **Refresh recent chats** in the sidebar's **Live updates** section, or **Refresh sidebar now** in the popup, to check immediately (rate limited to prevent repeated requests).
- Chat IDs not present in ChatGPT's native sidebar appear as temporary links under **Recents → Live updates**. The original React-owned sidebar list is not rewritten; links disappear from the extension's list when ChatGPT's native list catches up.
- Works with two separate Chrome profiles **without Chrome Sync or a SuperAgent backend**, provided both are signed in to the **same ChatGPT account**. Each installation independently checks the account on chatgpt.com.
- Existing tabs, active messages, unsent drafts, current chat URLs, and ongoing streams are not reloaded, clicked, or modified. The sync feature does not write to ChatGPT's server.
- **An empty new chat is not necessarily stored in history.** It normally appears after the first message is sent and ChatGPT has saved it.
- The sidebar section is tied to the current ChatGPT web markup and may need updating when the site changes. If the account/history endpoints fail, the feature displays an error instead of reporting a successful refresh. The native sidebar remains available.

**Important:** The extension does **not** force the built-in ChatGPT React cache to invalidate. Instead it adds an independently refreshed set of links under the left menu. Do not rely on these links for operations such as ChatGPT's built-in pin/unpin or deletion; those remain in the native list.

## Privasi dan keamanan

- Izin terbatas pada `storage`, `tabs`, dan host `https://chatgpt.com/*`.
- Sidebar synchronization performs **read-only first-party fetches** to `/api/auth/session` and `/backend-api/conversations` on `chatgpt.com`. The access token is used in memory only to authenticate ChatGPT's history requests; it is never logged, persisted, returned to the popup, or sent to any other origin. The endpoint is not a public API and may change. No WebSocket, debugger, analytics, or external server is used.
- The new sidebar feature reads **conversation IDs and titles** to display local links. It discards message mappings, snippets, response content and token-bearing session data, and never stores chat metadata in Chrome storage; only UI settings are persisted. The message-rendering feature still stores no message text.
- Tidak mengirim/menyetop pesan, klik tombol ChatGPT, menyetel input, atau membuang node chat milik React.
- Tidak mengubah `chrome-extension/`, `chrome-extension-delegate/`, atau source kode SuperAgent.
- Pergantian route pada ChatGPT SPA dideteksi tanpa `history.pushState` monkey-patch.
- Turn yang mengandung fokus keyboard atau teks yang sedang diseleksi tidak disembunyikan.

## Verification

From the SuperAgent repository root:

```powershell
bun --bun x vitest run tests/chatgptLiteExtension.test.ts tests/chatgptOptimizerSidebar.test.ts
node --check chrome-extension-chatgpt-lite/policy.js
node --check chrome-extension-chatgpt-lite/content.js
node --check chrome-extension-chatgpt-lite/sidebar.js
node --check chrome-extension-chatgpt-lite/popup.js
bun --bun x tsc --noEmit
```

Tests cover safe DOM optimization, permissions, sidebar response validation, authenticated first-party read requests, two independent browser simulations, session failure and disabled-state behavior.

**Verification boundary:** the test harness simulates extension DOM and network calls. The same-origin session+history request was separately verified in a live authenticated Chrome tab, without changing that tab. End-to-end testing with the unpacked extension installed in two real Chrome profiles is still required to certify compatibility after site updates.

## Files

- `manifest.json` — MV3 extension configuration and site-only permissions.
- `policy.js` — pure rendering and sidebar-list policies.
- `content.js` / `content.css` — reversible message rendering optimization.
- `sidebar.js` / `sidebar.css` — authenticated read-only history sync and extension-owned sidebar links.
- `popup.html` / `popup.css` / `popup.js` — controls, statistics and manual sidebar refresh.
- `../tests/chatgptLiteExtension.test.ts` — message-rendering tests.
- `../tests/chatgptOptimizerSidebar.test.ts` — sidebar behavior and safety tests.

Version: 0.2.0. Icons are in `icons/icon.svg` and PNG 16/32/48/128 px. Regenerate with `node chrome-extension-chatgpt-lite/generate-icons.mjs`. No separate SuperAgent server or background daemon is required.
