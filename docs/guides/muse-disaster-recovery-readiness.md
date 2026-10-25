# Phase 4o — Muse Disaster Recovery & Production Readiness

Panduan operator untuk **independent Muse/Telegram channel-host** di SuperAgent. Dokumentasi konfigurasi provider alert ada di [panduan Phase 4n](muse-recovery-alert-configuration.md); detail arsitektur di [rencana rolling restart](../plans/2026-10-25-superagent-core-rolling-restart.md).

## Prinsip keamanan

- Tidak ada perintah di sini yang otomatis **menjalankan ulang tool** setelah crash. Tool dengan status STARTED atau hasilnya belum pasti **harus direkonsiliasi operator**.
- Command \`dr-drill\` menjalankan **proses Bun anak** yang keluar tidak normal di direktori **temp OS khusus untuk pengujian**. Ia tidak memakai file recovery aktif, token, Muse/Telegram, MCP tunnel, model, atau workspace proyek.
- \`readiness\` dan \`recovery-wizard\` **read-only**. Mereka tidak menyalakan host, menjalankan tool, menghapus lock, atau memperbaiki journal.
- Mengirim alert sungguhan **harus** meminta \`alert-test --confirm-send\` dengan provider yang **sudah dikonfigurasi secara eksplisit**. Jangan menggunakan Chat ID atau URL contoh untuk pengiriman nyata.
- Jangan mengartikan skor readiness 100 sebagai jaminan keselamatan produksi atau bukti operator benar-benar menerima notifikasi.

## 1. Jalankan disaster-recovery drill tanpa mengganggu sistem aktif

~~~powershell
superagent channel-host dr-drill --port 7892
~~~

**15 skenario isolasi**:
1. Proses Bun pengujian dihentikan tidak normal setelah checkpoint disk tertulis.
2. Batch yang crash tetap dikenali setelah proses baru.
3. Tool yang telah STARTED tidak bisa di-resume sebagai untouched.
4. Argumen tool tersimpan terenkripsi.
5. Pemeriksaan konsistensi antar-store.
6. Backup dibuat dari state yang tervalidasi.
7. Secret tidak tertulis di manifest.
8. Backup yang dimodifikasi ditolak sebelum restore.
9. Tidak menulis ke target sebelum validasi backup.
10. Restore ke direktori kosong lengkap dan tervalidasi.
11. Batch STARTED tetap ditolak untuk replay setelah restore.
12. Hasil yang belum ACK tetap tersimpan tanpa rerun tool.
13. Queue dan cursor insiden tidak diduplikasi setelah restore.
14. Konfigurasi provider terenkripsi tetap utuh.
15. Restore ke direktori port yang sudah berisi state ditolak.

Perintah hanya mengeluarkan ringkasan \`ok\`, \`checks\` dan \`failed\`, bukan isi checkpoint atau path sensitif. Jika semua lolos, dicatat **bukti lokal tanpa rahasia** \`~/.superagent-r/muse-dr-drill-PORT.json\`; bukti valid 7 hari untuk indikator readiness. File ini bukan tanda tangan kriptografis atau jaminan drill terhadap environment produksi.

**Jika gagal:** jangan memulihkan produksi menggunakan sumber hasil simulasi. Periksa test failure, jalankan pemeriksaan storage produksi secara terpisah, dan eskalasi ke operator.

## 2. Periksa production readiness (read-only)

~~~powershell
superagent channel-host readiness --port 7892
superagent channel-host readiness --port 7892 --json
superagent channel-host readiness --port 7892 --backup "D:\SecureBackups\muse-7892-new"
superagent channel-host readiness --port 7892 --backup "D:\SecureBackups\muse-7892-new" --max-backup-age-hours 168 --json --strict
~~~

Status:
- **PASS:** semua delapan area telah lulus pemeriksaan lokal.
- **WARN:** ada setup/bukti yang belum tersedia atau melewati batas umur yang disarankan.
- **FAIL:** kondisi kritis, misalnya host tidak terverifikasi, journal/key rusak, bukti watchdog invalid/stale, atau backup yang dinyatakan rusak.
- \`--strict\`: keluar dengan status error bila hasilnya bukan PASS (untuk release gate/otomasi). Tanpa --strict, laporan tetap dapat dibaca meskipun ada FAIL.
- **Score** merupakan indikator lokal: setiap PASS mendapat 1 poin, WARN setengah, FAIL nol; tidak mengesampingkan FAIL.

Delapan area yang diperiksa: **host identity**, **recovery storage**, **incident queue**, **alert provider**, **bukti test alert**, **watchdog heartbeat**, **bukti DR drill**, dan **integritas serta umur backup**. Tanpa \`--backup\` sistem melaporkan WARN, bukan mengklaim menemukan backup yang belum diverifikasi. Batas umur default backup adalah 168 jam. Backup harus dibuat offline dan disimpan terlindungi; checksum tidak menjamin tidak ada rollback oleh administrator jahat.

Waktu uji kirim provider dianggap mutakhir selama 24 jam, heartbeat watchdog harus diperbarui dalam 90 detik, dan drill harus dalam 7 hari. Bukti lokal dapat dipalsukan oleh pengguna OS yang menguasai file-file tersebut; skor bukan bukti keamanan eksternal.

## 3. Tes kirim alert yang benar-benar opt-in

Pertama atur target dengan [config commands](muse-recovery-alert-configuration.md). Setelah memverifikasi Chat ID atau endpoint milik sendiri:

~~~powershell
superagent channel-host config status --port 7892
superagent channel-host alert-test --port 7892 --confirm-send
~~~

Tanpa \`--confirm-send\`, tidak ada panggilan HTTP. Payload tes memiliki \`test: true\`; Telegram mencantumkan judul **TEST alert**. HTTP sukses berarti server provider menerima request, **belum** membuktikan pesan sampai ke operator. Provider tanpa konfigurasi/gagal HTTP tidak menghasilkan bukti sukses.

Jika provider tersimpan dan HTTP diterima, hasil tes disimpan sebagai fingerprint **ciphertext konfigurasi** + timestamp; tidak menyimpan token/chat ID/URL. Mengganti provider akan menginvalidasi bukti lama, sehingga \`readiness\` kembali WARN hingga dilakukan tes baru. Fallback environment lama tidak menyimpan bukti fingerprint config baru.

**Jangan menjalankan tes ini ke provider pihak ketiga yang belum mendapat izin** atau menganggapnya sebagai health check tanpa efek: perintah ini memang mengirim satu notifikasi eksternal.

## 4. Jalankan watchdog dengan parent supervisor

Pada shell/proses terpisah dari channel host:

~~~powershell
superagent channel-host watchdog-supervise --port 7892 --interval-seconds 30
~~~

Parent supervisor hanya mengawasi **proses watchdog yang ia buat sendiri**, dengan budget paling banyak 5 restart dalam 10 menit dan exponential backoff. Ia **tidak** membuat ulang channel host, mengambil alih listener, menyentuh MCP, atau membersihkan lock. Jika watchdog terus mati, supervisor berhenti setelah budget habis dan meminta pemeriksaan operator. Agar supervisor itu sendiri hidup setelah reboot/crash, kelola dengan Windows Task Scheduler/service manager atau supervisor OS yang sudah dipercaya.

Watchdog menulis metadata heartbeat lokal \`~/.superagent-r/muse-watchdog-PORT.json\`. File hanya memuat port, PID, waktu observasi dan boolean online. Itu metadata diagnostik, bukan bukti autentikasi owner; verifikasi owner dilakukan terpisah oleh watchdog terhadap identitas PID+instance channel host dari loopback.

Watchdog **bisa tetap online** ketika channel host mati dan membuka insiden \`host_unavailable\`, tetapi tidak menghidupkan host secara otomatis. Test liveness tidak memulai watcher atau replay tool.

## 5. Recovery wizard untuk pemeriksaan operator

~~~powershell
superagent channel-host recovery-wizard --port 7892 --backup "D:\SecureBackups\muse-7892-new"
superagent channel-host verify-store --port 7892
superagent channel-host incidents --port 7892
~~~

Wizard melaporkan item PASS/WARN/FAIL plus langkah yang aman. Contoh tindakan manual:
- **NO_VERIFIED_OWNER:** pastikan channel host benar-benar dijalankan oleh pemilik yang sah; jangan mencoba memakai port MCP tunnel.
- **RECOVERY_UNREADABLE:** lakukan inspeksi offline, jangan hapus journal/key atau mengulang batch STARTED.
- **ALERT_CONFIG_INVALID:** cek konfigurasi encrypted + key dan backup; jangan fallback otomatis ke secret lama.
- **BACKUP_INVALID / BACKUP_STALE:** buat bundle baru di path absolut kosong setelah host offline, lalu verifikasi.
- **WATCHDOG_STALE:** periksa parent supervisor; jangan otomatis membersihkan stale locks.
- **DELIVERY_NOT_TESTED:** hanya jalankan uji kirim setelah operator menyetujui destinasi.
- **DR_DRILL_NOT_RECORDED:** jalankan \`dr-drill\` yang aman dan terisolasi.

Mengakui insiden dengan \`acknowledge\` hanya mengubah status yang ditampilkan; tidak memulihkan batch atau journal.

## 6. Otomasi CI (Linux + Windows)

Workflow baru: \`.github/workflows/muse-disaster-recovery.yml\`. Trigger pada PR/push berkas Muse atau secara manual \`workflow_dispatch\`. Matrix:
- Ubuntu 24.04
- Windows 2025

Tahapan: Bun 1.4.2, \`bun install --frozen-lockfile\`, build TypeScript, uji Vitest Muse/Core terpilih, drill child process dalam temp folder, dan \`bun scripts/verify-core-supervisor.ts\`.

Jalankan lokal:

~~~powershell
bun run build
bun --bun x vitest run --maxWorkers=2 tests/museProductionReadiness.test.ts tests/museRecoveryBackup.test.ts tests/museIntegrityEnforcement.test.ts tests/museIncidentCenter.test.ts tests/museAlertConfigCommand.test.ts tests/channelHost.test.ts
bun dist/cli.js channel-host dr-drill --port 51671
bun scripts/verify-core-supervisor.ts
~~~

Workflow **tidak menggunakan provider eksternal, user config produksi atau MCP tunnel aktif**. CI runner harus mempunyai Bun dan dapat menjalankan child process. **CI yang baru dibuat belum bisa diklaim hijau di GitHub sampai workflow benar-benar berjalan**; hasil lokal tidak sama dengan status Actions remote.

## 7. Batasan dan release gates

**Belum tercakup:** kegagalan nyata seluruh host/sistem operasi pada mesin produksi, penerimaan Telegram/webhook sungguhan tanpa credentials terkonfigurasi dan izin operator, auto-restart supervisor induk pada level OS, HA terdistribusi, rollback-proof backup, atau exactly-once efek eksternal.

**Status operasional yang aman:** DR lokal PASS + tes integrasi terisolasi PASS, lalu operator memasang konfigurasi eksternal secara sadar, menyalakan watchdog dengan OS service manager, memvalidasi penerimaan alert nyata, dan meninjau backup/restore pada environment staging sebelum penggunaan produksi.
