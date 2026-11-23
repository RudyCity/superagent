# Integrasi Pusat Permintaan & Notifikasi Lintas OS (`apps/superagent-tray`)

File yang sudah terpasang di workspace `D:\backup from pc asus\Documents Development\superagent\apps\superagent-tray`:

- `src-tauri/src/notifications.rs` — Command Tauri `notify_access_request` & `open_request_center` dengan `tauri-plugin-notification` untuk **Windows**, **Linux**, dan **macOS** (plus fallback `notify-send` / `osascript` + event emitter `access-manager://new-request` & `access-manager://focus-request-center`).
- `src/utils/osNotification.ts` — Helper izin & deduplikasi notifikasi native per `request_id`.
- `src/components/RequestCenterPanel.tsx` — Panel UI **Pusat Permintaan** dengan sub-tab **Permintaan Akses Masuk** dan **Permintaan Aturan Aktif**.
- `src/hooks/useRequestCenterState.ts` — Sinkronisasi polling & event real-time dari endpoint Access Manager (`/api/access-manager/requests/incoming` dan `/api/access-manager/requests/rules`).
- `src/components/AccessManagerRequestCenterMount.tsx` — Wrapper tab siap-pasang di **Access Manager** lengkap dengan badge jumlah tertunda dan tombol **Tes Notif OS**.
- `src/__tests__/osNotification.test.ts` — Unit test Vitest untuk deduplikasi dan pemanggilan notifikasi OS.

## Langkah Penyambungan Entrypoint

1. **Cargo & Capabilities (`src-tauri/Cargo.toml` & `src-tauri/capabilities/default.json`):**
   - Tambahkan `tauri-plugin-notification = "2"` di `[dependencies]`.
   - Tambahkan `"notification:default"` di array `permissions`.
2. **Rust Entrypoint (`src-tauri/src/lib.rs`):**
   - Deklarasikan `mod notifications;`.
   - Daftarkan `.plugin(tauri_plugin_notification::init())`.
   - Masukkan `notifications::notify_access_request, notifications::open_request_center` ke `tauri::generate_handler![...]`.
   - Panggil `notifications::notify_access_request(...)` dari handler backend saat ada request `incoming_access` atau `active_rule` baru masuk.
3. **Frontend Access Manager (`src/App.tsx` / komponen Access Manager):**
   - Pasang `@tauri-apps/plugin-notification` (`bun add @tauri-apps/plugin-notification`).
   - Pasang `<AccessManagerRequestCenterMount />` sebagai bagian utama Access Manager atau render `<RequestCenterPanel />` pada tab **Pusat Permintaan**.
