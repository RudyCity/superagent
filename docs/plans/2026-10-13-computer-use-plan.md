# Rencana Computer Use Superagent dengan Pembatasan Keamanan

Disusun: 13 Oktober 2026
Status: draf rencana, belum ada perubahan kode
Dasar: pembacaan src/core/permissions.ts (150 baris pertama), toolsets.ts, dan daftar tool yang ada. Bagian yang belum dibaca dicatat di bagian 10.

## 1. Tujuan dan ruang lingkup

Agent bisa melihat layar desktop (screenshot dan daftar jendela), lalu menggerakkan mouse dan keyboard pada aplikasi yang sudah diizinkan. Setiap aksi harus bisa dihentikan, dibatasi, dan dicatat.

Di luar lingkup v1:

- Login ke akun pribadi atau memasukkan kredensial.
- Pembayaran, pembelian, atau pengiriman pesan atas nama user tanpa konfirmasi.
- Instalasi software dan perubahan pengaturan sistem.
- Akses ke password manager atau clipboard.
- Pemanggilan computer use dari MCP.

## 2. Kondisi saat ini (dari kode)

Yang sudah ada dan bisa dipakai ulang:

- Screenshot lewat browser: screenshotTool, playwrightScreenshotTool, dan controlChromeCdpTool. Ini hanya menangkap halaman browser, belum layar desktop.
- Deteksi elemen visual lewat server UI-DETR di port 8095 (controlChromeVisionTool). Bisa dipakai untuk menemukan tombol di screenshot desktop.
- Simulasi kursor untuk browser (simulateVirtualCursorTool, chromeCdpCursor). Hanya berlaku di dalam browser.
- Mekanisme izin di permissions.ts: pola berbahaya, pemblokiran perintah sistem, dan Scoped YOLO boundary.
- Klasifikasi MCP di superagentMcpServer.ts: safe dan dangerous.
- Hook permission_required di server.ts untuk meminta persetujuan user.

Yang belum ada:

- Kontrol input tingkat OS (mouse dan keyboard di luar browser). Tidak terlihat di daftar tool.
- Kontrol jendela aplikasi non-browser (fokus, daftar jendela, geometri).

Catatan desain: pendekatan blocklist regex di permissions.ts tidak cukup untuk input desktop. Perintah bisa disamarkan, dan jendela bisa berpindah di tengah aksi. Untuk input desktop, pendekatan harus allowlist, dan pengecekan dilakukan sebelum setiap aksi.

## 3. Arsitektur yang disarankan

Komponen baru:

- src/core/desktop/desktopController.ts: menangkap layar, mendaftar jendela, dan mengirim input. Implementasi Windows memakai helper terpisah yang berkomunikasi lewat JSON di stdin dan stdout, dengan timeout.
- src/core/desktop/desktopPolicy.ts: menyimpan allowlist aplikasi dan judul jendela, batas laju, serta status izin per sesi.
- src/core/desktop/desktopAudit.ts: log append-only untuk setiap aksi.
- Dua tool baru, dengan pemisahan read dan write:
  - desktop_observe: screenshot dan daftar jendela. Klasifikasi safe.
  - desktop_act: klik, ketik, tekan tombol, dan fokus jendela. Klasifikasi dangerous.

Tier yang boleh memakai:

- Superagent (depth 1) boleh, dengan izin.
- Master tidak boleh, sesuai aturan bahwa master tidak mengeksekusi aksi langsung.
- Subagent tidak boleh di v1.

## 4. Lapisan keamanan

Setiap lapisan berdiri sendiri. Jika satu gagal, lapisan berikutnya tetap menahan.

- L1 Opt-in global: setting desktopControl.enabled di model-config.json, default false. Tidak memakai process.env, sesuai aturan konfigurasi JSON-only.
- L2 Allowlist aplikasi: hanya jendela yang cocok dengan daftar nama proses dan pola judul yang boleh dikontrol. Jendela fokus diperiksa ulang sebelum setiap aksi, bukan hanya di awal tugas.
- L3 Persetujuan per sesi: saat desktop_act pertama kali dipanggil, minta izin lewat hook permission yang sudah ada. Opsi izin hanya berlaku untuk aplikasi yang disebut dalam permintaan.
- L4 Konfirmasi aksi berisiko: jika teks tombol atau label field di sekitar klik mengandung kata seperti kirim, bayar, hapus, beli, login, install, atau submit, aksi ditahan sampai user mengonfirmasi. Ini heuristik tambahan, bukan jaminan.
- L5 Batas laju dan waktu: jumlah aksi per menit dan durasi maksimum per tugas. Tombol Stop harus langsung menghentikan input yang sedang berjalan.
- L6 Kill switch: perintah /desktop stop dan failsafe. Jika kursor dipindah ke sudut layar, input dihentikan.
- L7 Kombinasi terlarang: blok Ctrl+Alt+Del, Win+L, Win+R, dan kombinasi daya. Input juga dihentikan jika jendela sistem seperti UAC atau layar kunci terdeteksi.
- L8 Audit: setiap aksi dicatat dengan waktu, sesi, jendela, jenis aksi, koordinat, dan hash screenshot. Screenshot disimpan di ~/.superagent-r/desktop/ dengan retensi, misalnya 24 jam.
- L9 Privasi: screenshot dikirim ke provider AI, jadi user harus diberi tahu sekali. Area tertentu bisa diredaksi. Layar aplikasi yang tidak ada di allowlist tidak boleh ditangkap.
- L10 Tanpa akses kredensial: tidak membaca clipboard dan tidak membuka password manager secara default.

## 5. Keterkaitan dengan rencana sebelumnya

- Perbaikan P1-c (abort dengan scope): tombol Stop desktop harus menghentikan sesi yang tepat. Tanpa P1-c, /api/abort tanpa session bisa menghentikan semua sesi.
- Perbaikan P2 (state global): permission dan allowlist harus per sesi, bukan global.
- Saran optimasi tools: desktop_observe dan desktop_act menambah dua tool. Sesuai saran S2, sebaiknya dikelompokkan dengan action enum dan tidak ditambah sebagai tool terpisah yang banyak.

## 6. Fase

- Fase 0, desain dan keputusan: setujui ruang lingkup, OS target, dan default disabled.
- Fase 1, read-only: desktop_observe dengan screenshot dan daftar jendela. Tanpa input. Audit log aktif. Risiko rendah.
- Fase 2, input terbatas: desktop_act hanya untuk aplikasi di allowlist. Izin per sesi, failsafe, dan batas laju aktif. Uji awal dengan Notepad.
- Fase 3, perluasan: menemukan elemen dengan UI-DETR di port 8095, konfirmasi aksi berisiko, dan redaksi area layar.
- Fase 4, lintas OS: macOS dan Linux. Opsional.

Saran versi: Fase 1 menjadi 1.14.0 karena fitur baru. Fase 2 menjadi 1.14.x. Setiap perubahan permissions dicatat di CHANGELOG.

## 7. Pengujian

Unit test, memakai mock driver karena CI tidak bisa mengirim input desktop:

- Jendela di luar allowlist ditolak.
- Kombinasi terlarang ditolak.
- Batas laju berfungsi.
- Abort menghentikan loop input.
- Default config adalah disabled.
- Aksi berisiko ditahan sampai ada konfirmasi.

Integrasi, di mesin Windows dengan Notepad sebagai target:

- Buka Notepad yang ada di allowlist, ketik teks, dan verifikasi hasilnya.
- Pindahkan fokus ke aplikasi lain di tengah tugas. Input harus berhenti.

Uji bypass:

- Jendela berganti setelah pengecekan awal.
- Jendela minimize saat aksi berjalan.
- Dialog UAC muncul.

Smoke test manual dilakukan di VM, bukan di mesin utama.

## 8. Keputusan yang perlu diambil

1. Ruang lingkup v1: hanya read-only (Fase 1), atau langsung input terbatas (Fase 2)? Saran: Fase 1 dulu.
2. OS target: Windows saja dulu? Saran: ya.
3. Granularitas izin: per sesi, per aplikasi, atau per aksi? Saran: per aplikasi per sesi.
4. Apakah screenshot boleh dikirim ke provider AI? Saran: boleh dengan pemberitahuan dan opsi redaksi, tetapi harus disetujui user.
5. Apakah computer use boleh diakses lewat MCP? Saran: tidak di v1. Tool dangerous di MCP dan tunnel sudah berisiko, sehingga desktop hanya lewat UI lokal.

## 9. Risiko utama

- Screenshot bisa memuat data sensitif yang lalu dikirim ke provider.
- Allowlist jendela bisa dilewati jika judul jendela berubah di tengah aksi.
- Input yang salah sasaran bisa mengubah data di aplikasi lain.
- Deteksi kata berisiko hanya heuristik dan bisa terlewat.

## 10. Belum diverifikasi

- Belum mengecek apakah ada helper input desktop di repo di luar browser.
- Belum membaca advancedAutomationTools.ts dan chromeVisionTools.ts secara detail.
- Belum membaca dispatcher yang menerapkan hook permission untuk tool baru.
- Penilaian bahwa blocklist regex tidak cukup adalah penilaian desain dan belum diuji.
- Belum dibaca: masterAgent.ts, RequestProcessor.ts, dan test permission yang sudah ada.
