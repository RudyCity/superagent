# SuperAgent Android Standalone — Grand Plan v1.0

**Tanggal:** 14 November 2026  
**Status:** Blueprint / belum diimplementasikan  
**Target repository:** [RudyCity/superagent](https://github.com/RudyCity/superagent)  
**Tujuan:** menjadikan HP Android sebagai **host SuperAgent Core + MCP Server mandiri**, dapat diakses dari internet tanpa komputer Windows/macOS/Linux yang harus menyala.

## 1. Visi dan definisi selesai

Android APK bukan remote control untuk desktop; Android adalah **host pekerjaan**. Koneksi internet dapat menggunakan gateway cloud/serverless, tetapi seluruh tindakan yang memerlukan akses perangkat dieksekusi di HP, bukan di PC.

**Definition of Done (produk):**
1. Instal APK pada HP ARM64; pengguna melakukan setup dan pairing tanpa PC.
2. HP memiliki identitas perangkat dan endpoint MCP HTTPS stabil yang hanya bisa diakses klien berotorisasi.
3. MCP client dapat memanggil `device.status`, membaca file yang dipilih pengguna, menjadwalkan tugas terbatas, dan menerima hasil.
4. HP menjalankan tugas dengan kapabilitas Android yang diizinkan, meski tidak ada PC terhubung.
5. Tindakan berisiko membutuhkan persetujuan lokal per sesi/per tindakan; kemampuan mencabut koneksi selalu tersedia.
6. Screen sharing hanya aktif setelah izin MediaProjection baru untuk setiap sesi; tidak ada capture diam-diam.
7. Aplikasi pulih dari disconnect, proses mati, dan reboot sesuai kemampuan resmi Android, tanpa menjanjikan background 24/7.
8. Hasil tes perangkat fisik, audit keamanan, dan rilis APK terverifikasi tersedia sebelum label stabil.

**Non-goals:** full Windows software di Android, root/ADB otomatis, akses aplikasi lain tanpa batas, screenshot tersembunyi, pengambilalihan saat layar terkunci, jaminan uptime 24/7 pada semua vendor, serta klaim full ChatGPT MCP untuk semua paket.

## 2. Baseline repository yang sudah ada

- `apps/superagent-lan-android/`: Java Android native companion (Android 10+, API 29; `targetSdk 35` pada snapshot yang ditinjau), versi di file Gradle `0.10.1-internet-tunnel`.
- Existing: onboarding pairing, QR/tunnel, Android Keystore dan TLS, approval lokal, MediaProjection, UI schema via Accessibility untuk operasi yang diizinkan, transfer file melalui Android pickers, STOP/revoke.
- Existing desktop: Bun/TypeScript Core (`src/`), MCP integrations, device tunnel broker (`src/core/deviceTunnel/`), QA/test suite, release artifact verification.
- **Gap kritis:** Android companion saat ini belum menjalankan Core umum sebagai host MCP. Core Bun tidak boleh diasumsikan bisa dibungkus langsung ke APK karena runtime, ABI/NDK, subprocess, native modules, dan Android sandbox perlu diuji.
- Reuse protokol, model kapabilitas, device identities, error codes, dan test contracts; **jangan menyalin hak desktop** menjadi hak Android secara otomatis.

## 3. Arsitektur target

```text
ChatGPT / Gemini / MCP Client / automation platform
             | HTTPS + OAuth + scoped MCP tools
             v
      MCP Gateway / Stable HTTPS URL
      (Cloudflare Worker + Durable Object, atau VPS relay)
             | outbound mutually authenticated persistent connection
             v
+----------------------------------------------------------+
| Android APK — SuperAgent Mobile Core                     |
|                                                          |
| Kotlin Android shell, lifecycle, service, permissions    |
| Runtime adapter / portable agent orchestration           |
| MCP tool dispatcher + allowlist + policy engine          |
| Task queue + encrypted local state + audit events        |
| Android Keystore + device identity + approval manager    |
| Device tools: battery, network, SAF files, apps/intents   |
| Optional tools: browser workspace, screen, bounded UI    |
+----------------------------------------------------------+
             | Android OS APIs; app sandbox; user consent
             v
             Owned Android device
```

### Keputusan desain

- **Gateway adalah relay, bukan komputer pengganti:** ingress publik dan OAuth berada di cloud; eksekusi perintah Android tetap lokal. Tidak butuh server desktop dan tidak perlu membuka port inbound pada HP yang berada di balik CGNAT.
- **Stable URL:** `https://<domain-owned>/mcp` diarahkan ke perangkat melalui authenticated device session; backend bisa dipindah tanpa memutus URL. Domain aktual ditentukan nanti.
- **MCP:** gunakan Streamable HTTP dan kompatibilitas versi protokol yang dinegosiasikan; jangan bergantung pada transport SSE lawas atau hardcode format satu vendor. Unit kontrak MCP lintas SDK wajib.
- **Runtime:** jangan mem-port seluruh dependency Bun pada rilis pertama. Mulai dari *portable core API* dengan implementasi Android-native (Kotlin dan library native bila dibutuhkan), dan uji feasibility penyertaan JS runtime untuk logic reusable. Semua fitur Node/Bun-dependent masuk compatibility matrix, bukan diklaim otomatis tersedia.
- **AI model:** cloud provider sebagai default; inference on-device opsional jika hardware dan baterai memadai. Token disimpan via Android Keystore-wrapped encrypted storage, tidak di-log dan tidak dikirim ke relay kecuali memang diperlukan oleh OAuth/transport.
- **Kepatuhan:** di Google Play, Accessibility tidak boleh dipakai sebagai agent yang secara otonom merencanakan dan mengeksekusi tindakan lintas-app; gunakan API khusus dan user-directed deterministic workflows. Sideload bukan alasan melewati izin/platform security Android.

## 4. Kontrak tool MCP v0

| Tool | Scope | Kebijakan |
| --- | --- | --- |
| `superagent_android_status` | read | Versi, status pairing, uptime proses, state Core |
| `superagent_android_capabilities` | read | Kapabilitas aktual dan izin, jangan mengarang izin |
| `superagent_android_battery` | read | Level, suhu bila tersedia, charging |
| `superagent_android_network` | read | Tipe jaringan, konektivitas; tanpa data sensitif berlebih |
| `superagent_android_files_list` | read:files | Hanya direktori/dokumen yang user pilih via SAF |
| `superagent_android_files_read` | read:files | Per-file grant; batas ukuran dan redaksi data sensitif |
| `superagent_android_task_start` | write:task | Allowlisted workflow; mungkin perlu konfirmasi lokal |
| `superagent_android_task_status` | read | Status, progres, trace ID, error code |
| `superagent_android_app_open` | write:device | Intent resmi dan persetujuan jika diperlukan |
| `superagent_android_screen_request` | consent:screen | Memunculkan flow izin di HP, tidak langsung mengambil layar |
| `superagent_android_screen_snapshot` | read:screen | Hanya saat MediaProjection disetujui dan masih aktif |
| `superagent_android_ui_schema` | read:ui | Saat sesi izin yang sesuai aktif; sanitasi data |
| `superagent_android_ui_action` | write:ui | Aksi terbatas, terarah oleh user, state/revision verified |
| `superagent_android_disconnect` | owner | Putus sesi, bersihkan token sementara |

**Larangan default:** arbitrary shell, root, ADB, perintah sistem tanpa izin, APK sideload otomatis, membuka file seluruh penyimpanan, notification mirroring penuh, OTP/password capture, dan operasi finansial/akun tanpa approval.

## 5. Roadmap implementasi — 9 fase

### F0 — Audit, ADR, dan feasibility gate

- Audit `src/core`, MCP entrypoints, `apps/superagent-lan-android`, dependencies native, tunnel, build/release pipeline.
- Buat `docs/plans/2026-11-14-superagent-android-standalone-master-plan.md`, ADR runtime dan threat model.
- Proof-of-concept Android ARM64 yang menjalankan dispatcher tool asli tanpa PC; uji embedded JS/portable Kotlin/Rust, ukuran APK, native modules, memori/baterai.
- **Gate:** keputusan runtime bisa dibuktikan pada HP fisik; ada daftar supported/unsupported modules.

### F1 — Modularisasi Core portable

- Pisahkan domain services (tool schema, policy, task lifecycle, model API, session receipts) dari Bun/OS adapter.
- Buat `AndroidRuntimeAdapter`, `CapabilityRegistry`, `PermissionBroker`, `TaskStore`, `EventLog`.
- Semua permintaan dieksekusi melalui policy engine; tidak ada bypass dari transport lain.
- **Gate:** tes parity kontrak desktop vs Android, tidak ada dependensi desktop pada Android build.

### F2 — APK host lokal mandiri

- Tambah tab `Core`, `Connections`, `Tasks`, `Files`, `Permissions`, `Logs` tanpa menghapus fitur LAN companion.
- Android native service dengan lifecycle sesuai tujuan resmi, status jelas, tindakan manual Start/Stop, notifikasi bila service aktif.
- Keystore identities, encrypted persistence, task queue bounded, crash-safe recovery.
- **Gate:** cold install sampai tool `status` dapat dipanggil via loopback lokal / test harness tanpa PC.

### F3 — Cloud relay dan koneksi internet no-PC

- Gateway HTTPS dengan stable `/mcp`, outbound WebSocket/H2 dari HP (sesuaikan dengan kompatibilitas proxy).
- Enroll device via OAuth/PKCE/device approval; device keys; rotating short-lived credentials; revoked tokens; rate limiting.
- Relay hanya metadata/protokol minimum; payload end-to-end encrypted bila requirement data menuntutnya; jangan menyimpan screenshot/file default.
- Backoff + jitter, heartbeat, NAT handover Wi-Fi ke data, offline queue yang tidak menjalankan aksi berisiko secara otomatis.
- **Gate:** dari internet seluler ke gateway, klien MCP non-ChatGPT membaca status HP via Wi-Fi/4G, reboot/disconnect terdeteksi.

### F4 — Full MCP interoperability

- `tools/list`, `tools/call`, error model, version negotiation, auth scopes, pagination jika perlu, cancellation/idempotency, trace IDs.
- Test dengan MCP Inspector / SDK client, Gemini-compatible client, dan koneksi ChatGPT pada akun/workspace yang benar-benar mendukung.
- Fallback: kompatibilitas aplikasi ChatGPT bergantung pada fitur akun; jangan memakai protokol tersembunyi atau mengklaim dapat di-bypass.
- **Gate:** setidaknya dua klien independen berhasil menggunakan `status`, `battery`, dan `task_status`; tool write hanya dapat diakses dengan grant yang benar.

### F5 — Produktivitas nyata tanpa PC

- Scoped Storage Access Framework (SAF) untuk file yang dipilih user, import/export, hashing dan transfer chunked.
- Workspace tasks dan workflow allowlist: pemrosesan teks, JSON, file lokal yang telah diberi izin, sinkronisasi artefak, API cloud tertentu.
- Browser: automation di WebView/Chromium yang dikelola aplikasi sendiri; bukan klaim CDP Chrome Android setara desktop. Open external apps via Android Intents bila diizinkan.
- Terminal sandbox opsional hanya bila runtime dibuktikan aman: sandbox folder aplikasi, job timeout, limit RAM/CPU, no privilege elevation.
- **Gate:** selesaikan tugas multi-step read-transform-save dalam sandbox pada HP tanpa PC.

### F6 — Live Screen dan UI interaction aman

- Reuse screen pipeline dan UI schema, namun bedakan mode support manusia dari autonomous agent.
- Request MediaProjection setiap sesi baru, foreground notification, indikator layar, immediate Stop dan revocation.
- Aksi UI dibatasi konteks aplikasi/permission; element id + revision; no stale click, no hidden screen, no credential field capture.
- Tindakan yang lebih sensitif memerlukan per-action approval; kebijakan Google Play ditentukan sebelum fitur dipublish.
- **Gate:** on-phone consent benar-benar wajib; deny/revoke menghentikan streaming/action; lock-screen/permission loss fail closed.

### F7 — Reliability, observability dan update

- Health snapshot: service state, latency, battery/thermal warnings, task backlog, reconnect diagnostics, crash reports redacted.
- Supervisor berbasis lifecycle Android, WorkManager untuk tugas deferred, pembatasan FGS, anti battery drain dan ANR.
- Update channel terpisah dari Android LAN legacy; signature validation, SHA256, rollback strategy, user-approved APK install.
- **Gate:** soak test Wi-Fi/cellular switch, doze, low battery, process kill, OS upgrade, screen-off, restart app; no false claim 24/7.

### F8 — Security certification dan release

- Threat model: malicious MCP client, stolen token/device, rogue relay, prompt injection, replay, tool escalation, CSRF/SSRF via tools, log leakage, battery denial of service.
- Penetration tests auth/rate-limit/consent, dependency scanning, build provenance/SBOM, APK signing, secret scanning.
- Physical tests Android 10–16+ on multiple vendors (termasuk OEM agressive battery management), debug vs release manifests.
- Release `preview` → `beta` → `stable` hanya setelah sign-off keamanan, UI, dokumentasi dan E2E.
- **Gate:** stable APK boleh didistribusikan; semua limitations terdokumentasi.

## 6. Prioritas rilis

| Milestone | Deliverable utama | Ketergantungan |
| --- | --- | --- |
| M0 Feasibility | Core status/battery di HP fisik tanpa desktop | F0–F1 |
| M1 Standalone Local | APK local MCP host + tasks + Keystore | F2 |
| M2 Internet Host | Endpoint HTTPS stabil + OAuth + no-PC relay | F3–F4 |
| M3 Useful Agent | File SAF + allowlisted workflows + local browser workspace | F5 |
| M4 Live Device | Visible consented screen + bounded UI | F6 |
| M5 Production | Recovery, signed updates, security/physical QA | F7–F8 |

**First public demonstration target:** install APK → pair with gateway → disconnect PC → connect MCP client → request status/battery → ask to process user-selected file → get result → revoke access on HP.

## 7. Security model

1. Trust default-deny; human owner is the security boundary.
2. Separate *pairing*, *session*, *screen consent*, *tool scope*, dan *per-action approval*.
3. Explicit read/write scopes, least privilege and revocation; no blanket `YOLO` crossing from desktop.
4. mTLS-style device identity or cryptographic outbound device authentication, OAuth for client→gateway; relay never substitutes user authorization.
5. Task idempotency and nonce/timestamps to prevent duplicate writes when network retries.
6. Sensitive fields redacted from logs; optional retention; device-local audit trail protected by encrypted storage.
7. Battery/CPU/network quotas and endpoint rate limits; fail closed when device offline or locked if action requires user presence.
8. Transparent current connection status, session owner and one-tap Stop/Revoke in APK.
9. No public inbound TCP listener on Android; no direct unauthenticated MCP endpoint.

## 8. Risiko dan penanganan

| Risiko | Mitigasi / keputusan |
| --- | --- |
| Bun/Node desktop API tidak cocok dengan Android | F0 POC dulu; modular shared contracts + Android-specific runtime; jangan klaim full port sebelum terbukti |
| HP di balik CGNAT | HP membuka koneksi outbound terenkripsi menuju gateway |
| Background dibatasi Android/OEM | FGS hanya untuk use case yang sah; WorkManager dan recovery; jelaskan tidak ada uptime 24/7 absolut |
| Screen capture dibatasi izin Android 14+ | MediaProjection per sesi; user consent dan indikator selalu terlihat |
| Google Play melarang Accessibility untuk agent otonom lintas aplikasi | Pisahkan deterministic human-directed controls dan safe API tools; review policy sebelum publikasi |
| ChatGPT custom MCP tergantung paket/fitur | Test MCP generik dulu; integrasi ChatGPT hanya sesuai akses plan/workspace, melalui web untuk setup |
| Token perangkat/gateway bocor | OAuth scopes + revocation + rotated tokens + Keystore device key |
| Remote commands bertabrakan | Session owner, lease, queue, idempotency, audit dan cancel |

## 9. Matriks uji dan acceptance

- **Connectivity:** Wi-Fi, 4G/5G, switching, captive portal, airplane mode, expired credential, relay restart, no desktop connected.
- **Security:** unauthorized MCP call returns denial; revoked key denied immediately; unknown device quarantined; action approval denied by default.
- **Lifecycle:** task resume vs cancel after process kill, phone reboot, Doze, battery saver, permission removal, OS force stop.
- **Screen/UI:** each capture session requests Android consent; STOP immediately ends sharing; stale UI revision rejected; lock screen fails closed.
- **Files:** only SAF granted paths; file size/number limits; revoke grants; resume chunk transfer integrity; never auto-read private directories.
- **Release:** signature, SHA-256 manifest, SBOM, min/target SDK review, reproducibility/release evidence, no silent installer.
- **Compatibility:** Android 10+ legacy client can remain separate while host runtime is evaluated; ARM64 support is primary.

## 10. Langkah engineering pertama (siap dibuat issues)

1. **SA-ANDROID-001:** Audit dependency Core untuk Android, porting matrix.
2. **SA-ANDROID-002:** Implement contract-first portable Tool Dispatcher dan Android capability registry.
3. **SA-ANDROID-003:** Prototype APK Core Host + `status/battery` + local test runner.
4. **SA-ANDROID-004:** Android Keystore device identity + encrypted store + approval manager.
5. **SA-ANDROID-005:** Cloud relay stable URL, OAuth, no-PC end-to-end.
6. **SA-ANDROID-006:** MCP interoperability tests + ChatGPT integration availability gate.
7. **SA-ANDROID-007:** Scoped file workflow + sandbox executor.
8. **SA-ANDROID-008:** On-demand UI/screen integration under Android/Play restrictions.
9. **SA-ANDROID-009:** Battery reliability, threat model, signed beta release and QA.

### Sumber teknis (diverifikasi 14 November 2026)

- SuperAgent repository: https://github.com/RudyCity/superagent
- Android client README: https://github.com/RudyCity/superagent/blob/main/apps/superagent-lan-android/README.md
- Android foreground services: https://developer.android.com/develop/background-work/services/fgs/service-types
- MediaProjection consent: https://developer.android.com/media/grow/media-projection
- Google Play Accessibility policy: https://support.google.com/googleplay/android-developer/answer/10964491?hl=en
- ChatGPT custom MCP access: https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- MCP authorization: https://apps.extensions.modelcontextprotocol.io/api/documents/authorization.html

**Catatan:** Dokumen ini hanya rencana. Tidak ada source code, database, release, ataupun perangkat pengguna yang dimodifikasi untuk membuatnya.