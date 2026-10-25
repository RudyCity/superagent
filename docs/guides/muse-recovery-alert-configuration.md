# Panduan Konfigurasi Alert Muse Channel Host

**Untuk:** operator SuperAgent / T-Line yang ingin menerima peringatan kerusakan recovery dan channel host offline.

**Berlaku mulai:** Phase 4n + command-config (commit 57e3f40f).

**Cakupan:** *independent channel host* Muse atau Telegram fallback; bukan bot gateway atau MCP tunnel umum.

> Alert **nonaktif secara default**. Command config tidak memulai host, watchdog, Muse watcher, maupun tunnel. Port 7892 di sini hanya **contoh**; ganti dengan port channel host milik Anda, **bukan** port MCP tunnel.

## 1. Lihat konfigurasi

~~~powershell
superagent channel-host config status --port 7892
superagent channel-host config help --port 7892
~~~

Status hanya menampilkan: port, mode (disabled/webhook/telegram), source (config/env/default), credentialConfigured, dan restartRequired. **URL, token dan Chat ID tidak pernah ditampilkan melalui status**.

## 2. Atur provider lewat command (tanpa mengedit .env)

### Pilihan A: Webhook HTTPS

~~~powershell
superagent channel-host config set-webhook https://alerts.example.com/hooks/superagent --port 7892
superagent channel-host config status --port 7892
~~~

Ganti domain dengan HTTPS endpoint **milik Anda yang tepercaya**. Program memvalidasi URL HTTPS DNS publik, menolak IP literal, URL dengan username/password, port khusus, fragmen dan redirect. Karena argumen CLI dapat masuk *shell history* atau daftar proses, hindari webhook URL dengan token rahasia pada path/query. URL tidak dibagikan melalui status, tetapi **nilai argumen saat setup tetap dapat diamati sistem operasi**.

Webhook menerima POST JSON metadata berikut (contoh, bukan data nyata):

~~~json
{
  "version": 1,
  "event_id": "generated-stable-id",
  "port": 7892,
  "kind": "integrity",
  "condition": "failed",
  "observed_at": 1792911000000
}
~~~

Jenis insiden: integrity atau host_unavailable. Payload **tidak berisi prompt, tool arguments/results, credential, path, atau batch ID**. Header Idempotency-Key memakai ID event agar penerima webhook bisa melakukan deduplikasi.

### Pilihan B: Telegram (Windows PowerShell)

Siapkan **bot token alert** dan Chat ID tujuan. Credential alert ini **terpisah** dari konfigurasi bot/channel Telegram yang dipakai untuk tugas Muse.

Untuk menghindari token masuk command history, input menggunakan prompt PowerShell yang tersembunyi, kemudian pipe ke stdin:

~~~powershell
$botToken = Read-Host "Telegram alert bot token" -AsSecureString
[System.Net.NetworkCredential]::new("", $botToken).Password |
  superagent channel-host config set-telegram --chat-id -123456789 --token-stdin --port 7892
Remove-Variable botToken
superagent channel-host config status --port 7892
~~~

**Ganti -123456789 dengan Chat ID yang benar.** Token akan menjadi string plaintext sementara **di memori PowerShell/Bun** tetapi tidak diketik sebagai argumen CLI atau percakapan. Jangan simpan token ke file skrip, log, Git, atau screenshot. Telegram menggunakan HTTPS Bot API; menjalankan config saja **tidak** mengirim pesan uji atau memverifikasi penerimaan.

Hanya **satu provider aktif per port**. Set-webhook atau set-telegram berikutnya menggantikan provider sebelumnya.

## 3. Command T-Line (terminal interaktif SuperAgent)

~~~text
/muse host config status --port 7892
/muse host config set-webhook https://alerts.example.com/hooks/superagent --port 7892
/muse host config disable --port 7892
/muse host help
~~~

Command Telegram **sengaja tidak menerima token melalui T-Line**, agar rahasia tidak masuk chat, model context, session history, atau log. Gunakan cara PowerShell --token-stdin di atas.

## 4. Ganti provider atau nonaktifkan

Untuk mengganti provider, jalankan ulang command set-webhook/set-telegram. Dispatcher membaca config **sebelum setiap percobaan pengiriman**: tidak perlu restart channel host/watchdog.

~~~powershell
superagent channel-host config disable --port 7892
~~~

Disabled tersimpan permanen sampai diubah dan **mengalahkan environment lama**. Pengiriman berhenti, tetapi riwayat insiden dan pending alert tidak dihapus. Legacy SUPERAGENT_MUSE_ALERT_* hanya digunakan **jika tidak ada saved per-port config**. Jika konfigurasi rusak/tidak bisa didekripsi, pengiriman diblokir tanpa fallback.

## 5. Monitoring, insiden, dan dashboard

Config provider **tidak memulai monitoring dengan sendirinya**. Jalankan channel host secara eksplisit dan aman, misalnya untuk inspeksi:

~~~powershell
superagent channel-host serve --port 7892 --mode idle
~~~

Idle tidak menyalakan koneksi Muse/Telegram. Jika benar-benar diperlukan untuk pekerjaan Muse, gunakan mode muse-ws atau telegram-fallback **setelah** memastikan kredensial dan kepemilikan channel valid. Jangan menjalankan dua Telegram poller untuk bot yang sama.

Agar tetap bisa mendeteksi host yang **mati total**, jalankan watchdog **sebagai proses terpisah**:

~~~powershell
superagent channel-host watchdog --port 7892 --interval-seconds 30
~~~

Watchdog harus tetap berjalan melalui terminal/service supervisor tersendiri; ia **tidak** otomatis dijalankan oleh config command atau dihidupkan ulang setelah crash tanpa pengelola proses eksternal.

~~~powershell
superagent channel-host status --port 7892
superagent channel-host integrity --port 7892
superagent channel-host alerts --port 7892 --limit 20
superagent channel-host incidents --port 7892 --limit 20
superagent channel-host deliver-alerts --port 7892
~~~

Deliver-alerts mengirim **paling banyak satu** alert yang sudah waktunya dikirim; bila provider disabled, antrian kosong, atau masih dalam backoff, tidak ada pengiriman. Watchdog-once melakukan **satu observasi yang bisa mengubah state** (misalnya mencatat host offline), bukan pembacaan murni.

Dashboard lokal **read-only**, tersedia selama host aktif:

~~~text
http://127.0.0.1:7892/_channel/incidents/dashboard
~~~

Lifecycle: OPEN (terdeteksi) → ACKNOWLEDGED (ditinjau operator) → RESOLVED (lulus inspeksi atau watchdog membuktikan host online). Operator ACK **tidak** memperbaiki penyimpanan, memulai host, atau menjalankan ulang tool:

~~~powershell
superagent channel-host acknowledge --port 7892 --incident INCIDENT_ID --confirm INCIDENT_ID
~~~

## 6. Penyimpanan, backup dan keamanan

Config dan log setiap port berada dalam direktori pribadi **~/.superagent-r** (Windows umumnya C:\Users\USERNAME\.superagent-r):

| Berkas | Isi |
| --- | --- |
| muse-alert-config-PORT.json | Provider config terenkripsi AES-256-GCM |
| muse-alert-config-PORT.key | Kunci enkripsi lokal |
| muse-incidents-PORT.json | Insiden, ACK, status antrean, deduplication cursor |
| muse-integrity-PORT.jsonl | Hash-chained integrity transition ledger |

File konfigurasi dan kunci ikut **verified recovery backup**. Jangan unggah backup ke Git: siapa pun yang bisa membaca ciphertext **dan** key file bisa mendekripsi provider config. Enkripsi lokal **bukan** hardware-backed secret storage atau perlindungan dari akun administrator yang berhasil membaca semua file.

Contoh backup hanya ketika owner channel host pada port itu **offline**, dan destination baru/kosong:

~~~powershell
superagent channel-host verify-store --port 7892
superagent channel-host backup --port 7892 --destination "D:\SecureBackups\muse-7892-new"
superagent channel-host verify-backup --port 7892 --source "D:\SecureBackups\muse-7892-new"
~~~

Backup termasuk recovery keys dan anti-replay state; akses perlu dibatasi. Restore hanya ke **per-port storage kosong** dan memakai port yang sama. Detail lengkap ada di [roadmap rolling restart](../plans/2026-10-25-superagent-core-rolling-restart.md).

## 7. Troubleshooting cepat

| Masalah | Pemeriksaan |
| --- | --- |
| Status disabled | Pastikan port benar dan jalankan set-webhook atau set-telegram |
| Provider configured tapi tidak ada pesan | Cek incident queue, pending/backoff, host/watchdog hidup, dan endpoint penerima |
| Telegram tidak menerima | Periksa token, Chat ID, hak kirim bot ke grup/chat, serta akses HTTPS |
| Config integrity failed | Key atau ciphertext hilang/dirusak; **jangan hapus acak**. Review dan restore backup terverifikasi |
| Notifikasi ganda | Pengiriman **at-least-once**; receiver webhook perlu deduplikasi berdasar event_id |
| Dashboard gagal dibuka | Pastikan host berjalan dan gunakan port/mesin yang sama (127.0.0.1) |
| Host offline menurut watchdog | Cek owner identity dan status; jangan otomatis replay tool |

**Batasan penting:** tidak ada jaminan exactly-once di Telegram; DNS target webhook belum dipin ke IP publik terverifikasi, sehingga gunakan endpoint milik sendiri. Tidak ada auto-repair journal, auto-replay tool, atau restart host otomatis dari alert center.

## 8. Pengujian terkait

~~~powershell
bun run build
bun --bun x vitest run --maxWorkers=2 tests/museAlertConfigCommand.test.ts tests/museIncidentCenter.test.ts tests/museRecoveryBackup.test.ts tests/channelHost.test.ts
bun scripts/verify-core-supervisor.ts
~~~

Panduan ini menjelaskan cara konfigurasi operasional. Untuk detail implementasi, fail-closed integrity gates, incident delivery dan recovery backup, lihat [rencana Phase 4k–4n](../plans/2026-10-25-superagent-core-rolling-restart.md).
