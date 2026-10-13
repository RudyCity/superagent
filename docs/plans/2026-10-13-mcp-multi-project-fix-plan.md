# Plan Perbaikan Superagent: Routing Multi-Project, Gerbang Plan, dan Scope Abort

Disusun: 13 Oktober 2026
Status: implementasi awal dan verifikasi terarah selesai; verifikasi penuh dan review akhir masih diperlukan
Versi dokumen interaktif: https://claude.ai/code/artifact/d6b844ed-a983-407a-9347-69a81724260c

## 1. Tujuan

Membuat Superagent aman dipakai dari MCP untuk beberapa project sekaligus. Ada tiga masalah utama: task dari MCP berjalan di project yang salah, invoke bisa melewati persetujuan plan, dan abort menghentikan session lain.

## 2. Batasan saat ini

- Subagent tidak tersedia lewat MCP untuk sementara. Eksplorasi dan implementasi dikerjakan langsung, sehingga aturan di AGENTS.md tentang delegasi eksplorasi ke subagent belum bisa dipenuhi.
- Grep di tool MCP rusak (selalu mengembalikan seluruh file). Pembacaan repo memakai list dan read per file.
- Semua temuan di dokumen ini berasal dari pembacaan kode. Belum ada yang diuji runtime.

## 3. Temuan

| ID | Temuan | Lokasi | Keyakinan |
|---|---|---|---|
| T1 | run_task, invoke, dan spawn_subagent dari MCP tidak mengirim workspace target. callServerApi hanya mengirim body, tanpa header x-workspace-path dan tanpa sessionId. | src/core/mcp/tools/processTools.ts (40-107); executionTools.ts (14, 24-33) | Tinggi |
| T2 | Tanpa header, server memilih session CLI pertama atau lastActiveWorkspace. Invoke HTTP membuat worktree di workspace hasil resolusi itu. | src/server.ts resolveSession (180-217), resolveWorkspacePath (239-257); src/serverRoutes.ts /api/superagents/invoke (1082-1104) | Tinggi |
| T3 | Gerbang plan di invoke bergantung pada agentLocalStorage. Route HTTP tidak punya store itu, sehingga pengecekan planState terlewat. | src/core/tools/superagentTools.ts (377-396) | Sedang, perlu diuji |
| T4 | /api/abort tanpa session menghentikan semua session dan menandai semua superagent sebagai terminated, lintas project. | src/serverRoutes.ts (949-974) | Tinggi |
| T5 | workspaceMode (local/ssh) diubah secara global di setiap request. Request paralel dari workspace berbeda bisa saling menimpa. | src/server.ts (751-774) | Tinggi |
| T6 | process.cwd() dan process.chdir() masih dipakai di jalur MCP. | workspaceTools.ts (45); executionTools.ts (105, 156); src/core/workspaceIsolation.ts (47, 57, 65) | Tinggi |
| T7 | Lokasi worktree di dokumen (~/.superagent-r/worktrees) berbeda dengan kode (<repo>/.worktrees). | AGENTS.md; docs/wiki/01-architecture-overview.md; superagentTools.ts (436); workspaceIsolation.ts (47) | Tinggi |
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

- workspaceMode: pindahkan ke session atau teruskan sebagai argumen eksplisit. Tahap awal: ubah hanya jika nilainya berbeda, dengan mutex sederhana.
- process.cwd() di jalur MCP diganti workspace target. setupWorkspaceForSession menerima repoRoot sebagai parameter.
- switch_workspace: dari process.chdir() menjadi aktivasi session. Ini perubahan perilaku dan harus ditandai di CHANGELOG.

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
5. Versi: 1.13.62 menjadi 1.13.63 untuk bug fix. Menjadi 1.14.0 jika P2 ikut dengan perubahan perilaku switch_workspace.
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
