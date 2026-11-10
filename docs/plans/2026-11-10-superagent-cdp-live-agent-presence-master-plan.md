# SuperAgent CDP — Live Agent Presence & Visual Browser Control Master Plan

**Tanggal:** 2026-11-10
**Status:** APPROVED SCOPE / PLANNED; belum diimplementasikan dalam dokumen ini.
**Repository:** SuperAgent, branch main. **Tidak membuat branch/worktree baru.**
**Baseline yang diverifikasi:** HEAD 61867ada (feat(cdp): add named cursor twins for headed Chrome), paket 1.14.66; working tree memiliki perubahan lain yang wajib dipertahankan.
**Tujuan owner:** implementasi seluruh 8 fitur: identitas cursor multi-agent, live cursor tracking, activity monitor, persistent cursor, collision protection, target highlight, action recording/replay, watch mode + human takeover.
**Kriteria kejujuran:** overlay pointer di viewport Chrome bukan pointer OS Windows kedua. Gerakan/klik yang diklaim sebagai aksi harus didukung event CDP nyata dan bukti perubahan halaman.

## 1. Kondisi awal dan batasan produk

Existing:
- src/core/tools/chromeCdpCursor.ts: overlay DOM cursor bernama per agent, gerakan Bezier melalui Input.dispatchMouseEvent, klik CDP native opsional, visual ripple, drag/drop.
- src/core/tools/chromeCdpTools.ts: control_chrome_cdp, cursorName, nativeClick, agent context, snapshot/verify, target/session routing.
- src/core/tools/chromeCdpSessionManager.ts: claim/lease, token, owner/observer/contributor, antrean write cross-process, expectedRevision, audit, handover.
- src/core/browserTransport/router.ts, targetIdentity.ts, managedCdpTransport.ts, delegateCdpTransport.ts: pemilihan transport dan target berkualifikasi; managed default, delegate opt-in, auto hanya discovery tanpa target eksplisit.
- src/core/tools/managedBrowserControl.ts dan src/serverRoutes.ts: existing native-managed human hold/takeover endpoints. docs/plans/2026-10-26-managed-browser-human-agent-handoff.md mencatat batas dan caveat ownership.
- docs/guides/delegate-cdp.md: Delegate-CDP menggunakan chrome.debugger allowlist, attach bounded, bisa menolak metode tanpa capability, tidak boleh fallback implisit.
- apps/superagent-tray/ui/: UI desktop existing; gunakan permukaan UI ini bila authorization/endpoint Core mendukung. T-Line adalah repo lain; integrasinya perlu kontrak terpisah, bukan edit implisit.

Batas:
1. Jangan mengubah semantik default click (DOM click) tanpa kompatibilitas; nativeClick:true hanya satu pasang mousePressed/mouseReleased, tidak boleh dobel submit.
2. Visual pointer 1 per agent per tab, tetapi CDP input sebenarnya tetap mempunyai satu state interaksi per target; jaga serialisasi. Satu pointer fisik OS tidak bisa diduplikasi melalui DOM/CDP.
3. Nama/avatar/warna adalah presentasi; identitas otorisasi HARUS agentId yang diautentikasi, session token, target identity dan revision/generation. Jangan percaya cursorName atau browser DOM sebagai principal.
4. Jangan merebut Chrome/DevTools/takeover user lain, melakukan auto-retry mutasi ambigu, mengaktifkan Delegate-CDP tanpa opt-in, atau membocorkan token/cookie/form/screenshot/URL rahasia di telemetry.
5. Jangan menyentuh perubahan dirty milik agent lain, tidak reset/clean, tidak mengaktifkan runtime utama tanpa pemeriksaan owner dan persetujuan. Tidak perlu dependency baru sebelum opsi bawaan dievaluasi.
6. Scope awal adalah headed Chrome; headless berfungsi tanpa overlay/UI atau secara eksplisit dinyatakan tidak didukung. Perbedaan Windows/Linux/macOS diuji, bukan diasumsikan.

## 2. Hasil produk yang dituju (8/8)

### F1 — Multi-Agent Cursor Identity (P0)
- Buat identitas tampilan stabil berdasarkan actor agentId + session generation: label aman (maks 40 karakter), avatar inisial opsional, warna deterministik dari token desain yang lolos kontras, status idle/working/queued/paused/error.
- Overlay bersifat pointer-events:none dan aria-hidden; tidak mengubah hit testing, fokus, layout, clipboard, atau seleksi.
- Collision identitas: dua actor tidak boleh menimpa DOM overlay satu sama lain; hide/revoke hanya menghapus actor terkait; saat release/expiry target bersihkan overlay.
- Data name/icon tidak dipercaya; DOM update via textContent, bukan innerHTML untuk label dari user.
- Acceptance: dua hingga lima agent yang berwenang bisa menampilkan overlay berbeda pada satu tab, warnanya tidak berubah secara acak; tidak ada XSS atau perubahan click target.

### F2 — Live Cursor Tracking (P0)
- Jadikan dispatched CDP Input.* event sumber kebenaran; visual bertindak sebagai proyeksi dari aksi yang selesai/diakui, bukan simulasi sukses.
- Representasikan pointer move, click/double-click, drag gesture, scroll/wheel, typing indicator (tanpa isi teks), dan hover; tidak mengarang status jika event gagal.
- Sinkronkan scroll, device scale, zoom dan viewport resize; sertakan timestamp monotonic, sequence per target dan generation agar event lama ditolak.
- Coalesce movement update (target awal: <= 20–30 pembaruan visual/detik per tab, dapat disetel berdasar hasil benchmark); tetap dispatch CDP input sesuai kontrak fitur existing, jangan memotong gesture bermakna.
- Acceptance: headful CDP real menunjukkan target yang benar diklik tepat sekali; cursor dan click ripple sesuai koordinat viewport sebelum/sesudah scroll/zoom; tidak memblok pointer native.

### F3 — Agent Activity Monitor (P1)
- Panel "Browser Agents" di UI desktop existing (apps/superagent-tray/ui); desain ringkas, konsisten dengan UI existing (Hallmark / Antislop + Taste Design v1), bukan dashboard kedua.
- Tampilkan browser/transport, target berkualifikasi, judul tab yang sudah disanitasi, agent, role, status, queue depth, aksi ringkas terakhir, umur event, last error, mode human hold; pembatasan data berdasar hak observer.
- Operasi follow agent: pilih satu agent/target; read-only stream viewport metadata, screenshot bila user explicitly memilih dan diizinkan, tidak mengaktifkan kontrol otomatis.
- Arsitektur event: stream melalui Core server existing/authenticated WS atau event plumbing yang sudah ada, bukan port/server baru. Dukung disconnect/reconnect dengan sequence dan snapshot reconciliation; indikator stale/offline.
- UI: empty, loading, error/retry, reconnecting, permission denied; responsif 320/375/414/768/1280, keyboard/focus/a11y, reduced motion.
- Acceptance: 5 agent/5 target bisa dipantau; tab tidak hilang/duplikat saat reconnect; observer tidak mendapatkan kemampuan menulis.

### F4 — Persistent Cursor Across Navigation (P0)
- Untuk target managed yang berhak, gunakan mekanisme inisialisasi per dokumen (contoh Page.addScriptToEvaluateOnNewDocument + reinject pasca navigasi bila perlu); simpan identifier registration untuk cleanup melalui Page.removeScriptToEvaluateOnNewDocument.
- Tangani reload, cross-document navigation, SPA route change, frame attach/detach, target close/rebind, perubahan execution context, dan popup. Tetap scoped ke target generasi yang sama; tidak menyebar ke semua tab.
- Untuk Delegate-CDP: audit allowlist/capability chrome.debugger dahulu; jika metode persistent injection unsupported, gunakan jalur supported on-demand reinjection saat aksi/attach dengan status eksplisit, bukan membuka allowlist secara membabi-buta.
- Jangan menyimpan label/pointer injection pada target setelah human takeover, revoke, disconnect, close, atau expired claim; cleanup best-effort dan rekonsiliasi pada reconnect.
- Acceptance: reload dan navigasi mempertahankan overlay saat ownership valid, tanpa overlay yatim setelah pelepasan sesi; unsupported method melaporkan capability gap, bukan false PASS.

### F5 — Multi-Agent Collision Protection (P0)
- Reuse withCdpTargetWrite, withCdpTargetRead, per-target cross-process queue, claim/lease token dan expectedRevision dari chromeCdpSessionManager.ts; jangan membangun lock paralel yang tidak sinkron.
- Satu gesture atomik (move→press→drag→release atau move→click→verify) harus berada dalam satu mutating lease/critical section. Handover, pause, cancel, revoke mencegah gesture baru sejak fence generation.
- Tangani ownership bukan hanya targetId, melainkan qualified transport target + tab generation/revision; cegah cross-profile leaks dan ABA setelah tab ID reuse.
- Status antrian berbeda dari aktivitas berjalan; beri batas timeout/priority/cancel; refresh snapshot sebelum retry setelah stale revision; tidak replay mutasi ambigu.
- Pastikan observer hanya membaca; contributor hanya write sesuai grant; owner takeover/handover eksplisit. Selaras human hold existing yang menolak agent writes.
- Acceptance: 5 concurrent agents same-tab, exactly-once effective mutation per authorized command, ordered dispatch, no interleaving press/release; stale/cancelled/human-held commands fail closed, no unauthorized queued execution.

### F6 — Element Target Highlight (P1)
- Tambahkan overlay pra-aksi (bounding box + tag/role/selector yang disanitasi) terpisah dari identity cursor; no pointer capture/DOM modification, TTL pendek, style tidak mengganggu halaman.
- Resolve target via existing snapshot/index/CSS + DOM.getBoxModel atau getBoundingClientRect as appropriate, scrollIntoView hanya di dalam authorized action; audit Shadow DOM dan iframe/OOPIF capability.
- Validasi visible, non-zero rect, viewport clipping, stable locator, element hit-test, overlay/occlusion dan revision sebelum click. Jika berubah setelah highlight, abort/re-resolve, jangan blind click.
- Screenshot/vision optional dan permission-gated; tidak render isi field sensitif.
- Acceptance: highlight sesuai elemen pada responsive viewport, scrolled page, iframe yang supported; stale/hidden/covered element gagal aman tanpa click.

### F7 — Action Recording & Safe Replay (P2)
- Recording OFF by default, opt-in per tab/session dengan indikator aktif, stop dan retention control. Simpan metadata minimal: actor, target qualification/generation, event type, locator aman, coordinates viewport, frame reference, before/after hash atau bounded verification proof, revision, outcome, timestamps.
- Jangan simpan password, keystroke plaintext, tokens, cookies, raw HTML, screenshot, private URL query atau data form. Secara default catat hanya "type occurred"; jika operator perlu parameter replay, gunakan parameter placeholders/redacted dan explicit secure runtime injection, bukan menulis secrets ke trace.
- Privacy filter dan audit tidak boleh gagal diam-diam. Storage mengikuti izin/ACL existing; export memerlukan user action; tidak ada telemetry cloud by default.
- Replay selalu dry-run/preview dahulu, re-resolve locator, verify target/url/frame/state, expected revision dan capability grant; reject foreign tab atau changed generation.
- High-impact actions (submit pembayaran, kirim pesan/posting, delete, publish, ubah permission) memerlukan approval manusia per aksi, dan tidak otomatis diulang jika outcome uncertain. Tidak ada bypass CAPTCHA/2FA.
- Acceptance: trace record→preview→replay pada situs fixture aman berhasil; password tidak pernah muncul di file/log/export; replay gagal pada stale target, unauthorized actor, atau ambiguous confirmation.

### F8 — Watch Mode + Human Takeover (P2)
- Integrasi dengan native managed /api/browser/managed/control dan /api/browser/takeover/* existing, tidak membuat takeover authority kedua. Protokol FSM: agent_active → pause_requested → quiesced → human_held → handback_requested → revalidated → agent_active; failure/timeout → blocked.
- Pause/Stop: cancellable queue intent, bukan kill proses/Chrome. Biarkan gesture in-flight selesai/abort aman, tunggu fence generation; mouse button tidak tertinggal pressed. Freeze new writes saat human hold; boleh tampilkan passive/read-only watch jika izin masih berlaku.
- Manual takeover harus membutuhkan operator yang diautentikasi dan target/fingerprint generasi yang cocok. Handover kembali harus melakukan fresh snapshot, locator revalidation dan explicit resume; invalidasi in-flight cached coordinates dan idempotency keys.
- Delegate transport hanya bila hak chrome.debugger dan model ownership dapat dibuktikan tanpa konflik; jika belum ada native managed ownership parity, tampilkan Unsupported, jangan diam-diam attach/detach debugger milik orang lain.
- Acceptance: manusia mengambil alih tab yang benar, agent writes 100% ditolak saat hold, kembali hanya setelah revalidation; disconnect/crash/restart tidak membuat auto-resume berbahaya.

## 3. Kontrak arsitektur lintas fitur

**Sumber kebenaran**: coordinator lease/auth (siapa boleh beraksi), qualified target identity + generation (di mana), CDP/Delegate action result (apa benar terjadi), activity event bus (apa yang bisa dipantau). Activity bus dan UI bukan jalur untuk bypass permission.

Usulan DTO minimum (rancangan, finalisasi lewat test sebelum kode):
- BrowserAgentPresence: actorId, displayName, presentationColor, qualifiedTargetId, transport, sessionGeneration, role, state, lastSeenAt, sequence.
- BrowserActionEvent: eventId, traceId, actorId, targetRef, generation, sequence, category, phase [queued|started|dispatched|verified|failed|cancelled], safeSummary, timestamp, errorCode?, revision?.
- BrowserCursorEvent: actorId, targetRef, generation, sequence, viewportX/Y, kind, button?, visualState, timestamp.
- BrowserControlState: targetRef, generation, owner, humanHold boolean, holdReasonCode?, queueDepth, pausedSince?, capabilityMatrix.
- BrowserActionTrace: id, sessionRef, optedInBy, event metadata[], redactionVersion, createdAt, expiresAt.

Prinsip implementasi:
- Coalesce ephemeral cursor position di memory; persistent audit hanya metadata ter-redaksi. Gunakan authenticated local event stream existing dan bounded subscriber queues; snapshot-reconcile setelah reconnect; jangan merutekan raw browser content ke client tak berhak.
- Gunakan allowlist command dan capability per transport. Managed dan Delegate tidak dipaksa parity dengan membuka debugger API berbahaya.
- Per-target lifecycle cleanup harus idempotent pada unload/release/revoke/target closed/bridge disconnect; jangan gunakan timer zombie atau global overlay yang mempengaruhi tab lain.
- Native physical Windows pointer tidak digandakan; opsi OS-level ghost cursor di luar scope dan tidak boleh dijanjikan.
- Tidak ada direct browser mutation dari UI tanpa Core server side authorization + coordinator write gate.
- Feature flags default-off untuk monitor broadcast, recorder, replay, takeover expansion. Named cursor existing tetap backward compatible.

## 4. Pelaksanaan bertahap & dependency

| Gelombang | Paket kerja | Dependensi | Pintu keluar (gate) |
| --- | --- | --- | --- |
| G0 Audit | Map command/ownership kedua transport, UI endpoint existing, test matrix, current dirty tree; baseline focused tests | HEAD current | Daftar gap & kontrak disetujui, no accidental changes |
| G1 Foundation | F1 identity polish, F4 persistent lifecycle, cursor events schema & cleanup | G0 | Headful reload/navigation multi-agent PASS |
| G2 Interaction | F2 live tracking, F5 atomic gestures/collision fences, tests concurrency/cancel | G1 | CDP event + DOM effect benar; race test PASS |
| G3 Observability | F3 activity monitor, authenticated event stream, follow mode, status offline | G2 | 5-agent live panel + permission + reconnect PASS |
| G4 Target intelligence | F6 highlight + hit-test + frame/viewport handling | G2, G3 | Stale/occluded/iframe fixture PASS |
| G5 Human control | F8 pause/quiesce/takeover/handoff; reuse existing endpoints | G2, G3 | Human hold blocks every write; revalidate on handback |
| G6 Reproducibility | F7 opt-in record, privacy/redaction, dry-run and safe replay + approvals | G4, G5 | Security/redaction/exactly-once tests PASS |
| G7 Hardening | End-to-end both transport modes, leak/performance, packaging, rollout evidence | G1–G6 | All release gates below PASS |

**Urutan bukan delapan PR besar sekaligus.** Setiap gelombang satu delta kecil dengan review fokus; branch/worktree baru dilarang oleh permintaan owner pada workspace ini. Jika file sedang dimodifikasi agent lain, tunggu/pecah ke path independen, bukan overwrite.

## 5. Perkiraan file ownership per gelombang

- G1/G2: src/core/tools/chromeCdpCursor.ts, src/core/tools/chromeCdpTools.ts; bila perlu tambah modul scoped presence/lifecycle dan tests/chromeCdpCursor.test.ts, tests/chromeCdpTools.test.ts.
- G2/G5: src/core/tools/chromeCdpSessionManager.ts, src/core/tools/managedBrowserControl.ts; tests/chromeCdpMultiAgent.test.ts, tests/chromeCdpSharedTab.test.ts, tests/managedBrowserControl.test.ts. Modifikasi sempit, jangan rusak lease existing.
- G3: authenticated Core route/event dispatch yang ada pada src/server.ts / src/serverRoutes.ts, UI existing apps/superagent-tray/ui, tests endpoint/session authorization; tulis file UI baru jika lebih aman daripada menyentuh file besar milik agent lain.
- G4: modul target highlight terpisah + integration wiring di chromeCdpTools.ts; tests fixture DOM/shadow/iframe.
- G6: modul trace recorder/replay baru dengan storage TTL/redaction dan tests security/approval; jangan reuse log mentah CDP yang menyimpan payload.
- Cross-transport: src/core/browserTransport/*, src/core/delegate/cdpTransport.ts, extension-owned Delegate files hanya setelah path/permission capability audit; tes delegateCdpTransport dan delegateCdpExtension relevan.
- Dokumen: docs/guides/delegate-cdp.md, guide operator fitur, changelog/package version saat kode rilis.
- Dilarang edit tidak terkait: Tray Rust lifecycle, MCP owner runtime, PDF, Muse, Telegram, credentials, migrations atau dependency lock tanpa kebutuhan nyata dan review.

## 6. Test matrix yang wajib

### Unit & contract
- tests/chromeCdpCursor.test.ts — color/name sanitize, 5 overlays, per-agent remove, independent cursor position, click exact once.
- tests/chromeCdpTools.test.ts — cursorName/nativeClick/legacy click compatibility, highlight mode and feature flag routing.
- tests/chromeCdpMultiAgent.test.ts / tests/chromeCdpSharedTab.test.ts — concurrent actor queue, handover, role observer/owner, cancellation and revision fences.
- tests/browserTransportRouter.test.ts / tests/delegateCdpTransport.test.ts / tests/delegateCdpExtension.test.ts — target qualification, Delegate capability unsupported fail-closed, no fallback.
- tests/managedBrowserControl.test.ts — human hold and handback under concurrency.
- Tambahkan tests baru: presence event DTO/redaction/stream, recorder-replay, visual lifecycle, security authorization.

### Real headed browser E2E (WAJIB, bukan mock)
1. Isolated test-owned Chrome launched headless:false + CDP; jangan menutup browser Chrome milik user. Cleanup test Chrome PID hanya yang dibuat test, bounded.
2. Dua named cursor dalam tab sama → overlay positions berbeda, nama aman, 1 mousePressed + 1 mouseReleased + 1 user click pada native click.
3. Lima target/five agents → monitor menampilkan target sesuai generation; action streams tidak bocor lintas target/profile.
4. Reload, cross-document navigation, SPA navigation, scroll, zoom, viewport emulation, iframe fixture → posisi dan lifecycle benar.
5. Concurrent conflicting clicks/drag, queue timeout, stop during drag, manual hold while queued → tidak double dispatch / stuck button / unauthorized write.
6. DOM target removed/covered after highlight → re-resolution atau abort tanpa false success.
7. Recorder opt-in pada form berisi password/token → trace/export tidak mengandung raw secret; replay fixture aman dan dry-run/approval behavior benar.
8. Disconnect/reconnect Core/Delegate/extension → status stale, no replay of unknown mutation, cleanup and reconciliation idempotent.

### Regression, packaging & perf
- Focused bun --bun x vitest run ... berdasarkan files di atas; kemudian bun run build untuk semua source changes.
- UI visual smoke 320/375/414/768/1280, accessible keyboard navigation, reduced motion, dark/light as existing.
- Benchmarks: active 5 agents, p95 event propagation and CPU/heap/DOM nodes; tetapkan limit numerik final dari baseline yang diukur (jangan mengarang KPI).
- Build Rust/Tauri/desktop installer hanya jika code UI/bridge yang memerlukan packaging telah berubah; isolated test profile, tidak menyentuh runtime utama.
- Simpan evidence berupa terminal outputs dan redacted test artifacts. No fake PASS.

## 7. Security, privacy, operasional & release gates

R1. Semua action server-side diuji auth/authz; UI observer tidak bisa menyuntik input.
R2. Semua aksi mutasi serialized via existing coordinator dan target+generation; human hold fence menang mutlak atas agent.
R3. XSS, CSP, shadow/iframe, untrusted cursorName, URL query tokens, redaction/export diverifikasi.
R4. Tidak pernah merekam password, cookie, token, raw page text, full network payload; recording off default.
R5. Tidak ada implicit auto-replay, auto-fallback Delegate→managed, debugger stealing, target ambiguity, auto Chrome shutdown.
R6. Browser real headed E2E PASS, targeted unit + bun run build PASS, regressions click/drag/session PASS.
R7. Verified no orphan overlay, no stale writer/queue, no client memory leak setelah sessions expire/revoke/handover.
R8. Managed/Delegate parity matrix akurat, status Unsupported tertulis untuk fitur yang memang belum dapat didukung tanpa permission baru.
R9. Rollout flags OFF→internal canary→staging test→operator-approved primary. Untuk runtime owner aktif, verifikasi PID/identity dan drain sebelum restart; jangan silently restart MCP/Core/T-Line.
R10. Changelog/version/test evidence dan migration/rollback plan terdokumentasi sebelum release.
R11. Tidak ada file dirty milik pihak lain ditimpa, tidak ada blanket stage, commit hanya file yang diotorisasi ketika implementasi.
R12. Semua fitur F1–F8 masing-masing mencapai acceptance; satu fitur failing membuat status keseluruhan PARTIAL, bukan DONE.

## 8. Eksekusi berikutnya

1. Kerjakan G0 read-only audit dan capture baseline tests/real-browser ownership tanpa modifikasi.
2. Implementasikan G1 (presence identity + lifecycle) dan G2 (real events + collision fences) pada file ownership yang disepakati; jalankan focused tests & headful smoke sebelum melebar.
3. Setelah foundational gates hijau, lanjut G3/G4/G5/G6 sesuai dependensi. UI kontrol tidak diaktifkan sebelum permission dan human-hold test PASS.
4. Akhiri dengan G7 end-to-end/rollback/packaging evidence dan approval sebelum mengaktifkan di primary runtime.

**Definisi DONE:** seluruh delapan fitur tersedia melalui jalur yang didukung, berfungsi nyata pada browser Chrome headed, aman dari collision/takeover/privacy regressions, dan memiliki bukti pengujian. Pembuatan dokumen ini **bukan** bukti implementasi fitur F1–F8.
