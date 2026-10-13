# Master Plan Computer Use Superagent

Disusun: 13 Oktober 2026
Status: draf, belum ada perubahan kode
Lingkup: hanya computer use, termasuk jalur untuk model non-vision dan strategi hemat token. Perbaikan MCP, optimasi tools, dan fondasi state global berada di dokumen terpisah dan hanya disebut sebagai prasyarat.

Dokumen detail terkait:
- docs/plans/2026-10-13-computer-use-plan.md: rancangan awal dan lapisan keamanan.

## 1. Tujuan

Superagent dapat melihat layar desktop dan, setelah diizinkan, menggerakkan mouse dan keyboard pada aplikasi yang sudah ditentukan. Setiap aksi harus dibatasi, bisa dihentikan, dan tercatat. Model non-vision harus tetap bisa memakai fitur ini, dan biaya token harus rendah.

## 2. Ruang lingkup

Termasuk:

- Menangkap screenshot layar atau jendela desktop, disimpan lokal untuk audit.
- Mendaftar jendela dan memfokuskan jendela di allowlist.
- Klik, ketik, dan menekan tombol di jendela allowlist.
- Menemukan elemen di layar tanpa mengirim gambar ke model.
- Audit setiap aksi.

Tidak termasuk:

- Login ke akun, memasukkan kredensial, atau membaca password manager.
- Membaca clipboard secara otomatis.
- Pembayaran, pembelian, pengiriman pesan, atau persetujuan atas nama user tanpa konfirmasi eksplisit.
- Instalasi software, perubahan pengaturan sistem, atau kontrol UAC.
- Akses dari master agent atau subagent.
- Akses lewat MCP pada versi awal.
- Dukungan macOS dan Linux pada versi awal.

## 3. Kondisi saat ini

Yang sudah ada dan bisa dipakai ulang:

- Screenshot browser lewat screenshotTool, playwrightScreenshotTool, dan controlChromeCdpTool. Ini menangkap halaman browser, bukan desktop.
- Server deteksi elemen UI-DETR di port 8095, dipakai oleh controlChromeVisionTool.
- Jalur CDP untuk browser. Repo memuat test chromeCdpSnapshotAccessibility.test.ts, yang menandakan adanya snapshot aksesibilitas. Isinya belum dibaca.
- Hook permission_required di server untuk meminta persetujuan user.
- Klasifikasi safe dan dangerous untuk tool MCP.

Yang belum ada:

- Tangkapan layar desktop di luar browser.
- Pohon UI Automation dari aplikasi desktop.
- Input mouse dan keyboard tingkat OS.
- Daftar jendela dan kontrol fokus jendela.
- Audit khusus aksi desktop.
- OCR, bila belum ada di repo (belum diverifikasi).

Catatan:

- Blocklist regex di permissions.ts tidak cukup untuk input desktop. Pemeriksaan harus berupa allowlist dan dilakukan sebelum setiap aksi.
- model_limits.ts hanya berisi batas konteks per model. Tidak ada registri kemampuan vision di file itu, sehingga kemampuan vision per model belum diketahui sistem.

## 4. Ancaman utama

1. Injeksi lewat konten layar. Teks di halaman web, dokumen, atau chat yang terlihat di layar bisa berisi instruksi palsu. Ini juga berlaku untuk nama elemen dan teks hasil OCR. Semua teks dari layar diperlakukan sebagai data, bukan instruksi.
2. Aksi salah sasaran. Jendela berganti di antara pengecekan dan input, sehingga ketikan masuk ke aplikasi yang tidak diizinkan. Atau ID elemen yang sudah basi menunjuk elemen lain.
3. Kebocoran data. Screenshot atau teks layar yang memuat data pribadi atau kerja dikirim ke provider AI.
4. Aksi berisiko tanpa sengaja. Tombol kirim, bayar, hapus, atau setuju ditekan karena model salah membaca layar.
5. Kehilangan kendali. Input terus berjalan setelah user ingin berhenti.
6. Abuse dari proses lokal lain. Proses lain memanggil jalur computer use tanpa izin user.

## 5. Keputusan arsitektur

- Dua tool dengan pemisahan read dan write. desktop_observe untuk observasi dan daftar jendela (safe). desktop_act untuk input (dangerous).
- Representasi teks adalah jalur utama untuk semua model. Gambar tidak dikirim ke model kecuali sebagai cadangan terakhir (jalur E di bagian 6).
- Model memilih elemen dengan ID pendek. Koordinat dan pola kontrol disimpan di Superagent, tidak dikirim ke model.
- Pengecekan jendela fokus dilakukan sebelum setiap aksi input, dan jendela yang dicek harus sama dengan jendela yang menerima input.
- Helper input Windows berjalan sebagai proses terpisah dengan protokol JSON, dengan timeout dan kemampuan dihentikan.
- Konfigurasi di model-config.json dengan default disabled. Tidak memakai process.env.
- Setiap aksi, termasuk yang ditolak, dicatat ke audit log append-only.
- Screenshot disimpan di ~/.superagent-r/desktop/ dengan retensi default 24 jam.

## 6. Jalur observasi dan aksi

Jalur dipilih per langkah. Jika satu jalur gagal, Superagent naik ke jalur berikutnya.

### Jalur A: Pohon aksesibilitas Windows (UI Automation)

Helper Windows membaca pohon kontrol aplikasi: nama, peran, nilai, status enabled, dan bounding box. Hasilnya dikirim sebagai teks. Aksi dijalankan lewat pola kontrol (InvokePattern, ValuePattern) atau koordinat yang disimpan Superagent.

- Keunggulan: tanpa gambar, token kecil, akurasi tinggi untuk aplikasi standar seperti Notepad, Explorer, Settings, aplikasi Office, dan banyak aplikasi WinUI atau WPF.
- Keterbatasan: aplikasi dengan aksesibilitas buruk (game, canvas, sebagian Electron) memberi pohon kosong atau tidak lengkap.

### Jalur B: OCR dan deteksi elemen lokal

Screenshot diproses secara lokal: OCR untuk teks dan UI-DETR untuk kotak tombol dan field. Hasilnya digabung menjadi daftar elemen bernomor dan dikirim sebagai teks. Gambar tidak dikirim ke model.

- Keunggulan: bekerja untuk aplikasi tanpa aksesibilitas yang baik.
- Keterbatasan: OCR bisa salah membaca teks kecil. Mapping ID ke kotak bisa bergeser bila layar berubah antara deteksi dan klik. Ketersediaan OCR belum diverifikasi.

### Jalur C: DOM untuk browser

Untuk halaman di browser, jalur CDP dengan snapshot aksesibilitas dipakai sebagai representasi teks. Tidak memerlukan gambar. Isi implementasi belum dibaca.

### Jalur D: Keyboard dan perintah langsung

Pintasan keyboard, navigasi Tab, menu Alt, atau membuka berkas dengan path. Nol token gambar dan paling stabil. Dicoba lebih dulu bila tugas memungkinkan.

### Jalur E: Model vision terpisah sebagai pendeskripsi

Model vision dipanggil hanya untuk menghasilkan deskripsi teks dari layar. Model utama yang non-vision merencanakan dari teks itu. Ini cadangan untuk kasus sulit, dengan biaya gambar per langkah.

### Urutan prioritas

1. Jalur D bila tugas memungkinkan.
2. Jalur A untuk aplikasi standar.
3. Jalur C untuk browser.
4. Jalur B bila A tidak memberi hasil memadai.
5. Jalur E hanya sebagai cadangan terakhir.

### Format observasi untuk model

Contoh (ilustrasi, bukan keluaran nyata):

```
[window] Notepad | fokus | proses notepad.exe
e1 edit "Text editor" value="Halo dunia"
e2 button "Save" enabled
e3 menu "File"
```

Aturan format:

- Hanya elemen yang terlihat dan interaktif yang dikirim.
- ID pendek (e1, e2) dan stabil selama pohon tidak berubah.
- Koordinat tidak dikirim ke model.
- Nama elemen dipotong sampai beberapa puluh karakter.
- Hierarki hanya dikirim bila perlu untuk membedakan elemen dengan nama sama.

## 7. Strategi hemat token

Berlaku untuk semua jalur, termasuk vision.

| Strategi | Cara kerja | Efek |
|---|---|---|
| Observasi berbasis diff | Setelah langkah pertama, hanya perubahan yang dikirim: elemen baru, hilang, atau nilai berubah | Ukuran setiap langkah turun setelah langkah pertama |
| Cache pohon | Hash pohon per jendela. Jika hash sama, tidak dikirim ulang | Menghindari observasi ulang yang tidak perlu |
| Scope jendela aktif | Observasi hanya jendela yang diizinkan dan sedang fokus | Jumlah elemen turun |
| Filter elemen | Hanya elemen interaktif dan terlihat, nama dipotong | Teks per langkah turun |
| Batch aksi | Model mengembalikan beberapa aksi dalam satu giliran, misalnya ketik lalu Enter | Jumlah giliran turun |
| Verifikasi lewat baca nilai | Setelah aksi, baca nilai elemen target, bukan screenshot | Verifikasi murah |
| Tunggu stabil | Observasi setelah jendela berhenti berubah, bukan polling | Observasi berulang berkurang |
| Pangkas riwayat | Observasi lama diganti ringkasan. Screenshot tidak masuk riwayat percakapan | Konteks tidak membengkak |
| Batas langkah | Maksimum langkah dan token per tugas. Melewati batas, berhenti dan tanya user | Biaya tidak terkendali bisa dicegah |
| Crop dan kompresi | Bila gambar tetap diperlukan (jalur E), crop ke jendela dan turunkan resolusi | Biaya gambar turun |
| Model bertingkat | Langkah rutin memakai model lebih murah, perencanaan memakai model lebih kuat | Biaya per langkah turun |

Yang paling berdampak untuk tugas berulang adalah diff, cache, dan batch aksi.

## 8. Fase

### Fase 0: Keputusan dan desain

- Output: keputusan K1 sampai K7 di bagian 10 disetujui.
- Output: daftar aplikasi awal untuk allowlist dan pola judul jendela.
- Output: threat model di bagian 4 disetujui.
- Tidak ada perubahan kode.

### Fase 1: Observasi read-only

- Isi: desktop_observe untuk observasi dan daftar jendela, dengan output format teks dari bagian 6, bukan screenshot. Screenshot disimpan lokal untuk audit. Audit log. Config desktopControl.enabled default false. Allowlist aplikasi.
- Tidak ada input.
- Exit criteria:
  - Observe menolak jendela di luar allowlist.
  - Setiap panggilan tercatat di audit.
  - Default disabled terverifikasi lewat test.
  - Retensi screenshot lokal berjalan.
  - Output observasi berbentuk teks, dan tidak ada gambar dalam payload ke model. Diuji dengan memeriksa payload.
  - Pemberitahuan privasi tampil sebelum data layar pertama dikirim ke provider.

### Fase 2: Input terbatas

- Isi: desktop_act untuk klik, ketik, tekan tombol, dan fokus jendela, hanya untuk aplikasi di allowlist. Aksi merujuk ID elemen dari Fase 1.
- Pengecekan ulang nama dan posisi elemen sebelum aksi. Bila tidak cocok, aksi dibatalkan.
- Izin per sesi dan per aplikasi.
- Batch aksi dengan batas langkah dan token per tugas.
- Failsafe: kursor di sudut layar menghentikan input.
- Kill switch: perintah stop dari UI lokal dan tombol Stop langsung menghentikan input yang sedang berjalan.
- Batas laju aksi per menit dan durasi maksimum per tugas.
- Pemblokiran kombinasi tombol berbahaya: Ctrl+Alt+Del, Win+L, Win+R, dan kombinasi daya.
- Input dihentikan jika jendela sistem seperti UAC atau layar kunci terdeteksi.
- Uji awal dengan Notepad.
- Exit criteria:
  - Uji integrasi Notepad lulus.
  - Uji pergantian fokus di tengah aksi: input berhenti.
  - Uji minimize saat aksi berjalan: input berhenti.
  - Uji dialog UAC: input berhenti.
  - Uji Stop: input berhenti dalam batas waktu yang ditentukan.
  - Uji ID basi: aksi dibatalkan bila elemen berubah.
  - Semua uji dilakukan di VM.

### Fase 3: Deteksi elemen dan konfirmasi aksi berisiko

- Isi: jalur B (OCR dan UI-DETR) untuk aplikasi yang gagal di jalur A. Pemeriksaan teks sekitar tombol untuk kata berisiko seperti kirim, bayar, hapus, beli, login, install, dan submit. Aksi yang cocok ditahan sampai user mengonfirmasi.
- Redaksi area layar tertentu sebelum data dikirim ke provider.
- Jalur E sebagai cadangan, dengan crop dan kompresi.
- Exit criteria:
  - Aksi berisiko tidak berjalan tanpa konfirmasi.
  - Area yang diredaksi tidak muncul di payload ke provider. Diuji dengan memeriksa payload.
  - Heuristik kata berisiko diuji dengan kumpulan contoh positif dan negatif. Tingkat lolos dicatat sebagai angka, bukan klaim.

### Fase 4: Pengukuran hemat token

- Isi: pengukuran dengan tugas uji yang sama, untuk membandingkan screenshot per langkah, pohon aksesibilitas, dan pohon dengan diff. Strategi di bagian 7 diaktifkan satu per satu dan diukur dampaknya.
- Tugas uji: ketik teks di Notepad lalu simpan; ubah satu pengaturan di Settings; isi formulir sederhana di browser.
- Catat per tugas: jumlah langkah, token input dan output, tingkat keberhasilan, dan jumlah klik yang salah sasaran.
- Exit criteria: angka penghematan tercatat dari pengukuran. Tidak ada klaim penghematan sebelum pengukuran selesai.

### Backlog: lintas OS

- macOS dan Linux tidak dijadwalkan. Dibuka hanya setelah Fase 3 stabil.

## 9. Pengujian

Unit test, dengan mock driver:

- Jendela di luar allowlist ditolak.
- Pengecekan fokus dilakukan ulang sebelum setiap aksi.
- ID elemen basi menyebabkan aksi dibatalkan.
- Kombinasi terlarang ditolak.
- Batas laju berfungsi.
- Stop memutus loop input.
- Default config disabled.
- Aksi berisiko ditahan sampai konfirmasi.
- Setiap aksi, termasuk yang ditolak, tercatat di audit.
- Diff hanya mengirim perubahan, dan cache tidak mengirim ulang pohon yang sama.

Integrasi, di VM Windows:

- Notepad diizinkan: ketik dan verifikasi hasilnya.
- Fokus pindah ke aplikasi lain di tengah tugas: input berhenti.
- Minimize di tengah tugas: input berhenti.
- UAC muncul: input berhenti.

Uji keamanan:

- Konten layar berisi instruksi palsu. Model tidak boleh mengklik karena instruksi itu. Diuji dengan halaman uji yang sengaja berisi instruksi palsu, termasuk di nama elemen dan teks OCR.
- Permintaan computer use dari MCP ditolak.
- Permintaan dari subagent dan master ditolak.

Regresi: test permission, yoloMode, dan workspaceBoundaryPermission harus tetap lulus.

## 10. Keputusan yang perlu diambil

| No | Keputusan | Saran |
|---|---|---|
| K1 | Mulai dari read-only (Fase 1) atau langsung input (Fase 2) | Fase 1 dulu |
| K2 | OS target | Windows saja |
| K3 | Granularitas izin | Per sesi, per aplikasi |
| K4 | Data layar boleh dikirim ke provider AI | Boleh, dengan pemberitahuan dan redaksi, setelah disetujui user |
| K5 | Akses lewat MCP | Tidak pada versi awal |
| K6 | Jalur default untuk model non-vision | Representasi teks (jalur A, C, D), gambar hanya cadangan |
| K7 | Target hemat token | Ukur dulu di Fase 4 sebelum menetapkan target |

## 11. Prasyarat dari luar dokumen ini

Fitur ini bergantung pada perbaikan yang dibahas di dokumen lain. Prasyarat ini tidak dikerjakan di sini:

- Sebelum Fase 2: pembatasan abort per sesi, agar tombol Stop hanya menghentikan sesi yang tepat. Sebelum perbaikan ini, /api/abort tanpa session dapat menghentikan semua sesi.
- Sebelum Fase 2: izin dan allowlist harus per sesi, bukan global.
- Sebelum Fase 1 diluncurkan: keputusan K1 sampai K6 sudah disetujui.

## 12. Risiko

- Injeksi lewat konten layar bisa menyebabkan aksi yang tidak diinginkan. Ini risiko paling serius dan tidak bisa sepenuhnya dihilangkan. Mitigasi: allowlist, konfirmasi aksi berisiko, dan pengecekan sebelum setiap aksi.
- Deteksi kata berisiko hanya heuristik dan bisa terlewat. Jangan dijadikan satu-satunya pertahanan.
- Data layar dapat memuat informasi sensitif yang dikirim ke provider. Mitigasi: pemberitahuan, redaksi, dan retensi lokal yang pendek.
- Judul jendela bisa berubah, sehingga allowlist berbasis judul bisa meleset. Mitigasi: gabungkan nama proses dan judul, dan utamakan nama proses.
- ID elemen bisa basi. Mitigasi: periksa ulang nama dan posisi sebelum aksi.
- Hemat token bisa mengorbankan akurasi bila filter terlalu agresif. Mitigasi: ukur keduanya di Fase 4.
- Input yang salah sasaran bisa mengubah data user. Mitigasi: fase bertahap, default disabled, dan Stop yang cepat.

## 13. Yang belum diverifikasi

- Belum dicek apakah OCR sudah ada di repo atau harus ditambahkan.
- Belum dibaca isi chromeCdpSnapshotAccessibility.test.ts dan implementasi snapshot aksesibilitas.
- Belum dicek apakah ada registri kemampuan vision per model di Superagent.
- Belum diukur seberapa lengkap pohon UI Automation di aplikasi target.
- Belum ada angka token per langkah untuk jalur mana pun.
- Belum dicek apakah sudah ada helper input desktop di repo.
- Belum dibaca advancedAutomationTools.ts, chromeVisionTools.ts, dispatcher hook permission, dan test permission yang sudah ada.
- Penilaian bahwa blocklist regex tidak cukup untuk input desktop belum diuji.

## 14. Langkah berikutnya

1. Jawab K1 sampai K7 di bagian 10, atau revisi.
2. Setujui threat model di bagian 4.
3. Baca file yang belum dibaca di bagian 13.
4. Susun daftar aplikasi awal untuk allowlist.
5. Mulai Fase 1 setelah langkah 1 sampai 4 selesai.
