# Plan Perbaikan Superagent: Routing Multi-Project, Gerbang Plan, dan Scope Abort

Disusun: 13 Oktober 2026
Status: isolasi prompt, event SSE, workspace MCP, dan chain request-scoped diimplementasikan; build dan tes terarah lulus; suite penuh belum bersih
Versi dokumen interaktif: https://claude.ai/code/artifact/d6b844ed-a983-407a-9347-69a81724260c

## 1. Tujuan

Membuat Superagent aman dipakai dari MCP untuk beberapa project sekaligus. Ada tiga masalah utama: task dari MCP berjalan di project yang salah, invoke bisa melewati persetujuan plan, dan abort menghentikan session lain.

## 2. Batasan saat ini

- Subagent tidak tersedia lewat MCP untuk sementara. Eksplorasi dan implementasi dikerjakan langsung, sehingga aturan di AGENTS.md tentang delegasi eksplorasi ke subagent belum bisa dipenuhi.
- Grep di tool MCP rusak (selalu mengembalikan seluruh file). Pembacaan repo memakai list dan read per file.
- Temuan awal sudah sebagian diuji runtime melalui tes regresi terarah; suite penuh dan build setelah perubahan lanjutan tetap harus dijalankan.

### Progress dan gap setelah implementasi fase 1

- Selesai di fase 1: routing workspace untuk `run_task`/`invoke`, penolakan fallback lokal saat server menolak workspace, gerbang plan pada route invoke HTTP, dan abort yang meminta scope eksplisit.
- Belum selesai: inisialisasi otomatis workspace yang belum terdaftar. Untuk keamanan, perilaku saat ini tetap menolak request dan meminta session diinisialisasi secara eksplisit; jangan auto-call `/api/init` sebelum kontrak keamanan dan efek sampingnya diverifikasi.
- Belum selesai: `workspaceMode` masih state global yang dapat berubah oleh request paralel untuk target workspace berbeda.
- Diperbaiki pada fase terbaru: pending permissions/questions kini menyimpan pemilik agent, session ID, dan workspace; endpoint approve/answer memvalidasi pemilik; abort membatalkan prompt milik session terkait tanpa menyentuh prompt project lain.
- Sebagian routing MCP kini memakai modul pusat `workspaceContext.ts` sebagai SSOT untuk normalisasi target workspace dan klasifikasi penolakan server. `processTools.ts` mempertahankan re-export kompatibel; `executionTools.ts` dan handler Chrome memakai modul pusat langsung.
- Diperbaiki pada putaran ini: `handleSendMessage` meneruskan workspace eksplisit ke server dan menggunakan target sama untuk fallback; bila server menolak target, handler tidak melakukan fallback lokal. Handler Chrome juga menerima `args.workspace` dan tidak menentukan root lewat `process.cwd()` secara langsung.
- Verifikasi sebelum request-scoped mode: 33 tes pada lima file terarah lulus; hasil terbaru setelah AsyncLocalStorage: 44 tes pada tujuh file lulus, `bun run build` dan `git diff --check` lulus. Suite penuh `bun test` sebelumnya timeout pada batas tool, jadi hasil keseluruhan belum diketahui.
- Diperbaiki: referensi `fileTools.ts` yang tidak ada pada diagram arsitektur diganti dengan `fileReadTools.ts` dan `fileEditTools.ts`. Aturan `.gitignore` yang diperlukan sudah tercakup oleh `*.log`, `cdp_screenshot_*.png`, dan `tests/temp-home*`; tidak ditambahkan duplikasi.
- Perbaikan lanjutan: `workspaceMode` dan state active chain/node menggunakan AsyncLocalStorage; koneksi SSH dipisahkan per chain+node; pemilihan active chain dipersist per workspace dengan fallback konfigurasi legacy.
- Perbaikan lanjutan: tool chain pada agent dijalankan dalam request context; load chain menyinkronkan local/SSH mode. Endpoint chain status, health, delete, dan switch-node menggunakan workspace request.
- Perbaikan prompt: permission/question terikat ke agent/session; API approve/answer menolak sesi lain; abort menyelesaikan prompt yang dibatalkan agar tidak menggantung. Event SSE dengan metadata session/workspace kini difilter server-side dan Chrome extension menyertakan session/workspace saat berlangganan.
- Perbaikan MCP workspace: workspace disimpan per instance server MCP dengan AsyncLocalStorage untuk setiap tool call. `switch_workspace` tidak lagi memakai `process.chdir()` atau mengubah `lastActiveWorkspace` global. Handler MCP yang sebelumnya memakai `process.cwd()` kini membaca konteks workspace; sisa penggunaan cwd hanya untuk default/inisialisasi transport dan fallback.
- Tes regresi mencakup chain context, prompt ownership, SSE scope, workspace routing, MCP server, server HTTP, transport MCP, chain permissions, dan workspace isolation. Verifikasi terbaru: 138 tes terarah lulus pada 16 file; build TypeScript dan `git diff --check` lulus.
- Suite penuh belum bersih. Shard pertama dari empat menjalankan 820 tes di 77 file: 809 lulus, 1 skip, 10 gagal. Kegagalan yang terlihat termasuk konflik UNIQUE pada SQLite file-lock, tes Muse tanpa watcher aktif, mock `generateText` yang tidak terpasang, tes Chrome window yang menyentuh jendela browser nyata, serta timeout auto-checkpoint/PDF OCR. Karena test shard ini memengaruhi browser dan ada kegagalan environment-sensitive, shard sisanya tidak dijalankan pada sesi ini. Ini bukan bukti bahwa seluruh suite lulus.

### Urutan lanjutan yang aman

1. Jalankan suite penuh dan catat hasil aktual; perbaiki regresi jika ditemukan.
2. Audit integrasi runtime SSE dan Chrome extension lintas dua session/project nyata.
3. Pertimbangkan inisialisasi workspace otomatis hanya setelah kontrak keamanan dan efek samping diuji.
4. Verifikasi bahwa transport MCP HTTP/tunnel meneruskan workspace eksplisit sesuai konfigurasi per session.

## 3. Temuan

| ID | Temuan | Lokasi | Keyakinan |
|---|---|---|---|
| T1 | run_task, invoke, dan spawn_subagent dari MCP tidak mengirim workspace target. callServerApi hanya mengirim body, tanpa header x-workspace-path dan tanpa sessionId. | src/core/mcp/tools/processTools.ts (40-107); executionTools.ts (14, 24-33) | Tinggi |
| T2 | Tanpa header, server memilih session CLI pertama atau lastActiveWorkspace. Invoke HTTP membuat worktree di workspace hasil resolusi itu. | src/server.ts resolveSession (180-217), resolveWorkspacePath (239-257); src/serverRoutes.ts /api/superagents/invoke (1082-1104) | Tinggi |
| T3 | Gerbang plan di invoke bergantung pada agentLocalStorage. Route HTTP tidak punya store itu, sehingga pengecekan planState terlewat. | src/core/tools/superagentTools.ts (377-396) | Sedang, perlu diuji |
| T4 | /api/abort tanpa session menghentikan semua session dan menandai semua superagent sebagai terminated, lintas project. | src/serverRoutes.ts (949-974) | Tinggi |
| T5 | workspaceMode (local/ssh) diubah secara global di setiap request. Request paralel dari workspace berbeda bisa saling menimpa. | src/server.ts (751-774) | Tinggi |
| T6 | process.cwd() dan process.chdir() masih dipakai di jalur MCP. | workspaceTools.ts (45); executionTools.ts (105, 156); src/core/workspaceIsolation.ts (47, 57, 65) | Tinggi |
| T7 | Ada dua jenis worktree yang sempat tercampur dalam audit: worktree fitur Superagent (`~/.superagent-r/worktrees`) dan worktree isolasi session (`<repo>/.worktrees`). Dokumentasi harus membedakan keduanya, bukan menyamakan path. | AGENTS.md; docs/wiki/01-architecture-overview.md; superagentTools.ts; workspaceIsolation.ts | Tinggi |
| T8 | Dokumen wiki menyebut fileTools.ts, file yang tidak ada. | docs/wiki/01-architecture-overview.md | Tinggi |

## 4. Perbaikan

### P1-a Routing workspace dari MCP (T1, T2)

File: src/core/mcp/tools/processTools.ts, executionTools.ts, workspaceTools.ts.

1. callServerApi menerima opsi headers. Jika workspace diisi, kirim x-workspace-path.
2. Normalisasi workspace dengan path.resolve. Jika kosong, pakai workspace aktif MCP dan sebutkan itu di respons, supaya tidak diam-diam jatuh ke session CLI.
3. Jika workspace belum terdaftar (server membalas 403), panggil /api/init dulu lalu ulangi request.
4. run_task, invoke, dan spawn_subagent memakai helper yang sama.

Kriteria: dengan dua session untuk workspace A dan B, run_task dengan workspace B tidak menulis ke session A.

### P1-b Gerbang plan pada invoke HTTP (T3)

File: src/serverRoutes.ts (route /api/superagents/invoke). superagentTools.ts tidak diubah.

Ambil session dari workspace target, lalu bungkus eksekusi dengan agentLocalStorage.run(session.agent, ...). Jika session tidak ditemukan, balas 400.

Keputusan produk: apakah invoke MCP harus menunggu plan disetujui. Saran: ya, sesuai AGENTS.md.

### P1-c Scope abort (T4)

File: src/serverRoutes.ts (route /api/abort).

- Tanpa session dan tanpa flag all=true, balas 400.
- Status superagent dan subagent hanya diubah untuk session tersebut.
- pendingPermissions dan pendingQuestions dibersihkan per session, bukan dengan clear() global.

### P2 Hilangkan state global (T5, T6, T7)

- SSOT workspace: `workspaceContext.ts` menjadi satu pintu untuk resolusi/validasi konteks workspace MCP; handler tidak boleh mengimplementasikan normalisasi sendiri-sendiri.
- State runtime: `workspaceMode`, izin, pertanyaan pending, dan session identity harus dimiliki session/context, bukan mutable global. Teruskan context eksplisit ke fungsi yang membutuhkannya; jangan mengandalkan mutex untuk menutupi desain global.
- process.cwd() di jalur MCP diganti konteks workspace yang telah di-resolve. Fungsi setup menerima repoRoot/context sebagai parameter.
- switch_workspace: ubah dari process.chdir() menjadi aktivasi session hanya setelah semua consumer memakai context eksplisit. Ini perubahan perilaku dan harus ditandai di CHANGELOG.

### P3 Dokumentasi dan kebersihan repo (T7, T8)

- Perbaiki AGENTS.md dan docs/wiki/01 untuk lokasi worktree dan nama file.
- Tambahkan ke .gitignore: cdp_screenshot_*.png, vitest-profile*.log, dan tests/temp-home-worker-*.
- Pindahkan atau hapus screenshot dan log setelah disetujui.

## 5. Pengujian

Test baru di tests/:

- mcpWorkspaceRouting.test.ts: run_task dengan workspace B tidak masuk ke session A (T1, T2).
- invokePlanGate.test.ts: invoke HTTP ditolak saat plan belum disetujui (T3).
- abortScope.test.ts: abort tanpa session ditolak; abort dengan session hanya menghentikan session itu (T4).
- workspaceModeIsolation.test.ts: dua request dengan mode berbeda tidak saling menimpa (T5).

Sebelum menulis, baca test yang sudah ada: sessionSwitchSync.test.ts, cliWorkspace.test.ts, workspaceIsolation.test.ts, mcpSessionRegistry.test.ts, dan superagentLifecycle.test.ts.

Verifikasi: bun test dan bun run build.

## 6. Urutan dan rilis

1. Baca file yang belum dibaca: masterAgent.ts, toolsets.ts, RequestProcessor.ts, route /api/switch-workspace, dan test di atas. Revisi plan bila perlu.
2. Kirim rencana perubahan per file, tunggu persetujuan.
3. Kerjakan P1-a dan P1-c, lalu P1-b.
4. Tulis dan jalankan test.
5. Versi fase routing awal 1.13.63; perbaikan lanjutan terarah saat ini 1.13.64. Jika P2 mengubah perilaku `switch_workspace`, tentukan versi breaking terpisah setelah review.
6. Update CHANGELOG.md, lalu commit.

## 7. Keputusan yang perlu diambil

1. Invoke MCP harus menunggu persetujuan plan? Saran: ya.
2. run_task sinkron atau asinkron? Saran: sediakan parameter wait, dengan default asinkron.
3. switch_workspace tetap global atau diubah ke aktivasi session? Saran: diubah, karena ini breaking change dan perlu persetujuan.

## 8. Belum dibaca dan asumsi

Belum dibaca: masterAgent.ts, toolsets.ts, RequestProcessor.ts, cli.tsx, cliMain.tsx, config/jsonConfig.ts, route /api/switch-workspace, sebagian besar agent.ts, isi test, dan docs/wiki 02-07.

Asumsi yang belum diverifikasi:

- Server di port 7888 adalah proses yang sama dengan session CLI.
- Pemanggilan /api/init dari MCP tidak punya efek samping besar.

## 9. Kriteria selesai

- Dua project berjalan paralel dari MCP tanpa saling mengganggu.
- Invoke MCP tidak melewati persetujuan plan.
- Abort hanya menghentikan session yang diminta.
- Semua test baru dan test lama lulus, dan bun run build tanpa error.
- CHANGELOG, versi, dan dokumen sinkron.
