# Staging lokal Muse recovery tanpa provider eksternal

**Tujuan:** memverifikasi channel host, recovery journal, watchdog, kontrol akses IPC, backup, restart, restore, dan anti-replay *tanpa* menghubungkan Muse WebSocket, Telegram, webhook, MCP tunnel, model AI, atau koneksi eksternal.

## Cara menjalankan

Dari root repository SuperAgent di Windows PowerShell (atau shell Linux):

~~~powershell
bun run build
bun scripts/verify-muse-local-staging.ts
~~~

Script memilih port TCP loopback **secara otomatis** dan membuat folder run baru di bawah direktori home OS:

~~~text
~/.superagent-local-staging/<tanggal>-<random>/
  home/.superagent-r/               # state hanya untuk host staging
  backup/                           # bundle backup terverifikasi, termasuk kunci
  restored-home/.superagent-r/      # hasil restore ke namespace baru
  staging-report.json               # laporan 22 pemeriksaan
~~~

Jangan pindahkan file tersebut ke \`~/.superagent-r\` produksi, dan **jangan** unggah isi backup atau file terenkripsi beserta kuncinya ke Git. Script sengaja tidak menghapus hasil staging agar operator bisa mengaudit atau memakai backup untuk latihan berikutnya. Tidak pernah menghapus staging sebelumnya.

Staging memakai HOME/USERPROFILE dan SUPERAGENT_CONFIG_DIR **khusus subprocess**. Provider alert disimpan secara eksplisit sebagai \`disabled\` di staging; environment alert lama juga di-nonaktifkan di subprocess. Kode produksi, data asli, tunnel MCP aktif, dan port 7892 produksi tidak disentuh. Port yang dipakai adalah port acak yang tersedia. Proses host dibuat sebagai subprocess, terikat ke \`127.0.0.1\`, dalam **mode idle**, dan dihentikan **secara normal** setelah pengujian.

## Pengujian yang dilaksanakan

| Area | Bukti pemeriksaan |
| --- | --- |
| Isolasi | Port loopback acak, home staging terpisah, provider alert disabled |
| Recovery | Journal diinisialisasi menggunakan task lifecycle **metadata-only** tanpa menjalankan tool |
| Host | Listener HTTP lokal sungguhan, PID+instanceId diverifikasi dari discovery |
| Akses | POST IPC tanpa bearer ditolak HTTP 401 |
| Watchdog | \`watchdog-once\` mengamati online, offline, lalu online setelah restart |
| Offline protection | Backup saat owner aktif ditolak |
| Shutdown & restart | Registrasi/lock dilepas saat host berhenti, instanceId baru saat restart |
| Insiden | Offline episode dibuat dan diselesaikan saat host pulih, antrean tidak dikirim |
| Backup | CLI offline membuat bundle, lalu \`verify-backup\` memeriksa isinya |
| Restore | CLI memulihkan bundle ke home staging baru yang kosong; recovery journal dan config dibandingkan |
| Gate | Readiness tidak keliru menyebut kondisi tanpa provider dan host idle sebagai production PASS |

Sebanyak **22 assert** harus lolos. Satu run valid menghasilkan \`"ok": true\`, \`"verifiedChecks": 22\`, \`"outboundNotifications": 0\`, \`"externalWatcherStarted": false\`, dan \`"liveHostLeftRunning": false\`. Jika gagal, script menyimpan \`staging-error.json\` dan menggunakan exit code nonzero. Status backup/restore tidak diubah atau dipalsukan sebagai produksi.

## Kenapa readiness produksi tidak PASS?

Readiness umum diperuntukkan bagi **channel yang benar-benar operasional**. Staging ini menggunakan mode idle dan sengaja menghindari provider eksternal, sehingga hasil readiness biasanya **FAIL** saat host telah dihentikan atau WARN saat host idle, dan \`DELIVERY_NOT_TESTED\` tetap WARN. Ini **desain yang benar**, bukan kegagalan tes lokal. Laporan staging memiliki \`ok\` sendiri.

Jangan memaksa readiness menjadi PASS dengan menyimpan bukti pengiriman palsu atau menganggap heartbeat lama sebagai proses aktif. Bila nanti ingin mengaktifkan staging Muse WebSocket sungguhan, gunakan konfigurasi test yang terisolasi, port berbeda, dan persetujuan eksplisit tentang target jaringan/model.

## Watchdog supervisor

Script staging menggunakan command \`watchdog-once\` tiga kali untuk membuktikan observasi online/offline/recovery dan penyimpanan heartbeat lokal secara nyata. Logika parent \`watchdog-supervise\` yang restart child dengan budget terbatas sudah diuji melalui \`tests/museProductionReadiness.test.ts\`; script **tidak** membiarkan supervisor atau poller terpisah hidup tanpa pengelola proses. Untuk proses panjang atau auto-start setelah reboot, gunakan operator-managed Windows Task Scheduler/service supervisor sesuai [runbook Phase 4o](muse-disaster-recovery-readiness.md).

## Cara membaca hasil

~~~powershell
# Setelah run, baca lokasi staging-report.json dari output script
Get-Content "C:\Users\USER\.superagent-local-staging\<run>\staging-report.json"
~~~

Catatan: \`<run>\` adalah placeholder, bukan path tetap. Backup mengandung enkripsi dan kunci port staging; jangan membuka akses publik.

Untuk pengujian regresi isolasi setelah perubahan kode:

~~~powershell
bun run build
bun --bun x vitest run --maxWorkers=2 tests/museProductionReadiness.test.ts tests/museRecoveryBackup.test.ts tests/museIncidentCenter.test.ts tests/channelHost.test.ts
bun scripts/verify-muse-local-staging.ts
bun scripts/verify-core-supervisor.ts
~~~

GitHub Actions \`.github/workflows/muse-disaster-recovery.yml\` juga menjalankan staging smoke ini di matrix Ubuntu/Windows. **Status GitHub CI tidak dianggap berhasil sampai workflow betul-betul selesai dijalankan**. Tidak ada uji HTTP provider eksternal dalam smoke ini.

Untuk setting alert sungguhan di masa depan (di luar cakupan local-only ini), baca [panduan konfigurasi alert](muse-recovery-alert-configuration.md).
