# SuperAgent MCP — Named Tunnel Cloudflare rcity.web.id

Tanggal pemeriksaan: 2026-11-14. Catatan konfigurasi nyata, **tanpa menyimpan kredensial**.

## Bukti dari dashboard Cloudflare

- Akun Cloudflare yang terhubung memuat zona `rcity.web.id`, status Active, paket Free.
- Tunnel baru: `superagent-mcp-rcity`
- Tunnel ID: `b2e8c6d9-9317-4d9e-b381-826af22e1778`
- Pengelolaan tunnel: **remote-managed** melalui dashboard Cloudflare (menggunakan token konektor, bukan file kredensial JSON lokal).
- Published application: `mcp.rcity.web.id`
- Service origin: `http://127.0.0.1:19320` (Anchor terpisah, **bukan** owner MCP aktif di port 9227).
- Record DNS dibuat otomatis oleh Cloudflare: CNAME `mcp.rcity.web.id` ke `b2e8c6d9-9317-4d9e-b381-826af22e1778.cfargotunnel.com`.
- URL konfigurasi: https://dash.cloudflare.com/ef836fe6aa701883f22edcd538d22818/tunnels/b2e8c6d9-9317-4d9e-b381-826af22e1778
- Verifikasi DNS dari 1.1.1.1: hostname mengembalikan IP proxy Cloudflare.
- Probe `curl.exe -sS --head https://mcp.rcity.web.id/mcp` saat belum tersambung: **HTTP 530**.

## Pengaturan bawaan Tray (source v1.14.92)

Halaman **Settings → Cloudflare Named Tunnel** dan pintasan **Runtime → Cloudflare → Configure Named Tunnel** sekarang menyediakan konfigurasi native terpisah. Mode yang benar untuk tunnel Cloudflare ini adalah **Remote-managed · token file**, dengan hostname `mcp.rcity.web.id`, Tunnel UUID `b2e8c6d9-9317-4d9e-b381-826af22e1778`, Anchor port `19320`, private owner port `19321`, dan `cloudflared.exe` yang sudah dipasang.

Metadata tanpa kredensial disimpan di `~/.superagent-r/mcp-named-tunnel-settings.json`. **Token file path masih kosong** sampai operator menyimpan file token yang aman dengan izin OS terbatas. Form tidak menerima token mentah dan tidak pernah menjalankan `cloudflared`, menerbitkan DNS, restart owner atau memindahkan Gemini. Tombol **Check Local Readiness** hanya memeriksa keberadaan path/file secara lokal; status DNS, konektor dan OAuth masih harus dibuktikan sendiri.

**Catatan:** source v1.14.92 memerlukan build/update Tray yang benar-benar dipasang agar UI terlihat; menyimpan metadata di disk atau menjalankan unit test tidak berarti Tray terinstal sudah diperbarui. Skrip `start-named` sebelumnya masih ditujukan bagi konfigurasi local-managed; jangan berikan token remote-managed ke berkas JSON lokal. Aktivasi connector dan pengaturan Windows service memerlukan prosedur yang terpisah dan disetujui.

## Status sesungguhnya

**Belum online.** Tunnel berstatus Inactive, 0 active replicas. Endpoint di atas belum siap untuk Gemini atau ChatGPT. Jangan menganggap keberhasilan DNS sebagai keberhasilan layanan MCP.

Quick Tunnel yang sudah dipakai Gemini tetap berjalan di `https://tigers-dame-sys-lid.trycloudflare.com/mcp`; owner PID `25704`, backend PID `3364`, affinity drift `0` saat pemeriksaan. **Jangan stop, restart, migrasikan, atau ubah issuer OAuth ini.**

## Koneksi Cloudflare yang masih memerlukan tindakan operator

Sesi Cloudflare di Chrome Delegate telah login dan halaman detail tunnel telah terbuka. Dashboard menyediakan perintah `cloudflared.exe service install <TOKEN>` melalui tombol Copy. Token bersifat rahasia, jangan tempelkan di chat, PR, skrip dalam repo, atau rekaman command gateway.

**Revised security workflow (source v1.14.93):** Do not run or paste the Cloudflare dashboard `service install TOKEN` command. It may expose the token in process arguments or service metadata. Instead, save the remote-managed token in a private local file, open **Settings → Cloudflare Named Tunnel → Import Cloudflare Token File**, and use the native connector plan/start workflow with OS confirmation. The token is passed to `cloudflared` through `--token-file`, never as token bytes in arguments. See [Remote-managed operations](mcp-named-remote-operations.md).

Pra-pemeriksaan menemukan executable `C:\ProgramData\chocolatey\bin\cloudflared.exe`, serta **tidak ada Windows service Cloudflare Tunnel** yang terdaftar. Terdapat proses `cloudflared.exe` lain untuk Quick Tunnel; proses-proses itu tidak boleh dihentikan. Instalasi service baru memerlukan persetujuan UAC/admin dari pengguna.

## Integrasi SuperAgent setelah konektor sehat

**Updated in SuperAgent source v1.14.93:** the Remote-managed Tray profile now supports `start-profile PORT --reviewed` through the independent Anchor CLI, plus native token-file import, reviewed connector start/stop, and read-only health checks. The older `start-named` and `mcp-named-tunnel.ts` commands remain Local-managed only. Do not represent the new hostname as online until its connector, Anchor, OAuth owner and client are separately verified.

Sebelum menjadikan subdomain ini layanan MCP aktif, siapkan alur runtime remote-managed dengan validasi token-file/identitas tunnel yang aman, terpisah dari proses Quick Tunnel. Jalankan Anchor khusus pada 127.0.0.1:19320, lalu owner MCP terisolasi pada port internal berbeda (misalnya 19321) dengan profil konfigurasi privat, OAuth issuer `https://mcp.rcity.web.id`, dan tes init/tool/auth yang nyata. Jangan menyalin session ID atau OAuth token lama.

**Gerbang cutover:** verifikasi konektor, local anchor, health/backend, metadata OAuth, PKCE dan alat Gemini/ChatGPT pada hostname baru; pastikan proses pemulihan aman, lalu minta persetujuan eksplisit untuk mengganti URL di klien. Quick Tunnel lama tetap tersedia sampai cutover disetujui.

## Batas keselamatan

Tidak ada token atau file kredensial di dokumen ini. Jangan memasukkan token Cloudflare ke perintah yang dicatat otomatis oleh SuperAgent, Git, issue, atau chat. Pembuatan DNS dan tunnel baru tidak memerlukan restart owner lama. `HTTP 530` pada hostname baru berarti statusnya belum siap, **bukan kegagalan pada koneksi lama**.
