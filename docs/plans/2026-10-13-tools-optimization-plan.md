# Saran Optimasi Tools Superagent

Disusun: 13 Oktober 2026
Dasar: pembacaan src/core/tools/toolsets.ts dan daftar tool MCP. Belum diukur di runtime.
Versi dokumen interaktif: https://claude.ai/code/artifact/5139a102-daa6-4b48-b8fe-6f4e856c0d99

## 1. Ringkasan

Superagent mengirim skema semua tool yang aktif ke model di setiap giliran. Dari toolsets.ts, toolset superagent berisi sekitar 68 entri dan toolset master sekitar 48. Banyak tool tumpang tindih, dan toolset master masih memuat tool tulis yang seharusnya tidak dipakai master. Urutan yang disarankan: ukur dulu, rapikan toolset master, konsolidasi tool yang mirip, lalu kurangi permukaan MCP.

## 2. Temuan

| ID | Temuan | Lokasi | Dampak |
|---|---|---|---|
| O1 | Toolset superagent sekitar 68 entri, toolset master sekitar 48 (perkiraan dari daftar). | toolsets.ts (134-197, 211-281) | Skema dikirim setiap giliran; biaya token naik dan model lebih mudah salah pilih. |
| O2 | Empat tool edit file ditambah satu tool tulis: editTool, replaceFileContentTool, multiReplaceFileContentTool, applyPatchTool, writeToFileTool. | toolsets.ts (217-221) | Model harus memilih di antara tool dengan fungsi mirip. |
| O3 | Dua tool shell: bashTool dan runCommandTool. | toolsets.ts (225-226) | Duplikasi fungsi. |
| O4 | Tool browser dan screenshot tersebar: screenshotTool, playwrightScreenshotTool, controlChromeCdpTool, controlChromeVisionTool, controlIsolatedCdpTool, runHeadlessBrowserTool, controlBrowserTabTool. Tool Chrome juga berasal dari banyak file (chromeBrowserTools, chromeAdvancedTools, chromeExtraTools, chromeCdp*). | toolsets.ts (38-90, 258-278); src/core/tools/ | Permukaan browser paling besar dan banyak yang bisa digabung. |
| O5 | Master toolset memuat writeToFileTool, replaceFileContentTool, dan multiReplaceFileContentTool. Pembatasan hanya ada di runtime. | toolsets.ts (172-179) | Skema tulis tetap terlihat model master. Komentar di kode sendiri menyebut ini pernah dilanggar. |
| O6 | listToolsTool dan describeToolTool ada di master dan superagent. AGENTS.md juga menyebut alias get_tools, describe_tools, get_tool, cdp, emulate_device, dan drag_and_drop. | toolsets.ts (158-159, 279-280); AGENTS.md | Alias menambah nama yang harus dijaga dan memperbesar peluang salah pilih. |
| O7 | Mekanisme filter sudah ada: filterExtensionChatTools, EXTENSION_CHAT_HIDDEN_TOOL_NAMES, dan withModeAwareDiscoveryTools. | toolsets.ts (291 ke bawah); server.ts createAgentForMode | Titik perluasan yang sudah tersedia. |
| O8 | Daftar tool SuperAgent di MCP terlihat sekitar 63 entri di sisi klien. Allowlist 16 tool aman sudah ada untuk tunnel, tetapi belum terkonfirmasi untuk MCP non-tunnel. | src/core/mcp/superagentMcpServer.ts (MCP_TOOL_CLASSIFICATION); AGENTS.md (mcpTunnel) | Permukaan MCP yang terlihat klien terlalu besar. |

## 3. Saran

### S0 Ukur dulu

- Tambahkan penghitung jumlah tool per tier dan ukuran skema dalam token. TokenTracker sudah memakai tiktoken, jadi bisa dipakai ulang.
- Catat berapa kali setiap tool dipanggil dan berapa kali gagal, dari log atau riwayat. Tanpa data ini, konsolidasi bisa membuang tool yang masih dipakai.
- Buat baseline sebelum mengubah apa pun.

### S1 Rapikan toolset master (O5, O6)

- Keluarkan writeToFileTool, replaceFileContentTool, dan multiReplaceFileContentTool dari masterToolset. Bila master perlu menulis catatan, sediakan tool khusus yang hanya menulis ke ~/.superagent-r.
- ORCHESTRATION_TOOL_NAMES diturunkan dari masterToolset, jadi allowlist ikut berubah otomatis. Pastikan test terkait tetap lulus.
- Pembatasan runtime tetap dipertahankan sebagai lapisan kedua.

### S2 Konsolidasi tool yang tumpang tindih (O2, O3, O4)

Gabungkan dengan parameter action berupa enum, bukan dengan nama baru:

- Edit file: satu tool dengan mode replace, multi, patch, dan write. editTool dipertahankan sebagai alias sementara.
- Shell: bashTool dan runCommandTool menjadi satu.
- Browser: screenshotTool, playwrightScreenshotTool, runHeadlessBrowserTool, dan controlIsolatedCdpTool digabung ke controlChromeCdpTool dengan action. controlChromeVisionTool tetap terpisah karena bergantung pada server port 8095.
- Profil Chrome: listChromeProfilesTool, launchChromeProfileTool, listRunningChromeTool, dan closeChromeProfileTool menjadi satu tool chrome_profile.
- Proses: inspectPortTool, freePortTool, findProcessTool, dan killProcessTool menjadi satu tool process.
- Memori: lima tool rmemory*, saveSharedMemoryTool, readSharedMemoryTool, searchPinnedKnowledgeTool, dan loadPinnedSessionTool menjadi satu tool memory dengan action.

Risiko: model bisa salah memilih action. Atasi dengan enum yang ketat dan deskripsi action yang singkat.

### S3 Kurangi skema per giliran (O1, O7)

- Terapkan pemuatan tool bertahap: model hanya menerima kumpulan inti (perkiraan 15 sampai 20 tool). Sisanya ditemukan lewat list_tools dan describe_tool yang sudah ada.
- Pindahkan teks panjang di deskripsi tool ke describe_tool. Deskripsi di skema cukup satu kalimat.
- Gunakan filterExtensionChatTools sebagai contoh untuk filter per mode.

### S4 Audit alias (O6)

- Ukur dulu seberapa sering setiap alias dipakai. Jika tidak pernah dipakai selama beberapa minggu di log, hapus.
- Jika dipertahankan, sembunyikan dari skema dan hanya terima di dispatcher.

### S5 Permukaan MCP (O8)

- Periksa apakah MCP non-tunnel sudah memakai daftar aman sebagai default. Jika belum, gunakan MCP_TOOL_CLASSIFICATION: tool safe aktif, tool dangerous harus opt-in.
- Nama tool MCP adalah kontrak bagi klien. Jika diganti, sediakan alias selama satu rilis dan catat di CHANGELOG.

## 4. Pengujian

- toolRegistryConsistency.test.ts sudah ada. Tambahkan asersi bahwa tidak ada nama duplikat dalam satu toolset dan jumlah tool per tier tidak melewati batas.
- Untuk setiap tool hasil konsolidasi, test memetakan setiap action ke perilaku lama.
- Test bahwa masterToolset tidak memuat tool tulis ke kode.
- Test bahwa default MCP hanya mengekspos tool safe.

## 5. Urutan dan risiko

1. S0 ukur. Tidak mengubah perilaku.
2. S1 toolset master. Risiko rendah, dampak besar untuk keamanan dan pilihan model.
3. S4 audit alias. Risiko rendah.
4. S2 konsolidasi, satu kelompok per rilis: edit, shell, browser, memori, proses.
5. S3 pemuatan bertahap. Risiko tinggi karena mengubah cara model melihat tool.
6. S5 default MCP. Breaking change untuk klien.

Saran versi: perubahan perilaku tool, termasuk konsolidasi dan default MCP, sebaiknya 1.14.0. S1 bisa masuk 1.13.x karena memperbaiki pelanggaran aturan yang sudah ada.

## 6. Keputusan yang perlu diambil

1. Konsolidasi lewat parameter action diterima, atau nama lama harus dipertahankan untuk kompatibilitas?
2. Pemuatan bertahap diaktifkan untuk semua model, atau hanya model tertentu?
3. Default MCP non-tunnel diubah ke daftar aman?

## 7. Operational Log Audit — 2026-10-13

A read-only exploratory parse of `~/.superagent-r/superagent-tools.log` found 1,425 tagged tool-call lines spanning 2026-08-13 through 2026-10-13. The log covers multiple project directories and historical sessions, so this is directional evidence rather than a clean per-version benchmark. The most frequent canonical names in this sample were `bash` (428), `run_command` (289), `edit` (188), `write_to_file` (131), `manage_tasks` (80), `read` (77), and `replace_file_content` (51).

- This log does not establish model-schema token savings or tool-family equivalence.
- Error markers in the log are not a reliable success-rate metric by themselves; permission denials, nonzero shell exit codes, stale edit anchors, and real implementation failures need separate classification.
- No calls were found under the sampled compatibility alias names `get_tools`, `get_tool`, `describe_tools`, `cdp`, `emulate_device`, or `drag_and_drop`. This does not prove they are unused by other clients or unobserved periods, so aliases remain enabled.
- A regression test now checks that these documented aliases resolve to canonical tools without being separately registered in `allTools`.

## 8. Not Yet Verified

- The historical log is not a complete or version-isolated telemetry dataset; per-tool success/failure rates remain unverified.
- Browser-tool consolidation has not been validated against all current actions and compatibility contracts.
- No alias should be removed based on this sample alone.

## 9. Execution Update — 2026-10-13

### Verified against current code

- Repository baseline: branch `main`, HEAD `71fe761f`, working tree clean before changes.
- A one-off runtime baseline was captured from current TypeScript toolset exports. Counts and approximate `cl100k_base` schema estimates (serialized name, description, and parameters; not provider-billed token counts):

| Tier | Tool entries | Unique names | Serialized schema chars | Approx. tokens |
|---|---:|---:|---:|---:|
| Master | 48 | 48 | 35,800 | 7,692 |
| Superagent | 68 | 68 | 70,167 | 15,392 |
| Default subagent | 13 | 13 | 7,514 | 1,657 |
| Researcher | 23 | 23 | 13,926 | 3,019 |
| Coder | 30 | 30 | 20,630 | 4,447 |
| Reviewer | 16 | 16 | 9,313 | 2,083 |
| Software tester | 24 | 24 | 23,768 | 5,282 |
| Security engineer | 12 | 12 | 6,221 | 1,352 |
| Chrome agent | 36 | 36 | 33,548 | 7,143 |

- `masterToolset` intentionally includes `write_to_file`, `replace_file_content`, and `multi_replace_file_content` for Master-owned planning artifacts. `src/core/tools/fileEditTools.ts` applies `enforceMasterWriteAllowlist()` in the relevant write/replace execution paths, and `tests/masterWriteAllowlist.test.ts` verifies codebase writes are rejected while config-root artifact writes are allowed.
- Removing all three tools from the Master schema without a replacement artifact-writing contract is not safe. This step is deferred; do not treat the original O5 recommendation as a direct deletion instruction.
- `Agent.getActiveTools()` sources the Master tools from `masterToolset`; runtime tool availability and MCP multi-mode execution also depend on this array. `ORCHESTRATION_TOOL_NAMES` is derived from the same array.
- Before edits, focused tests passed: 3 files, 18 tests. After edits, the same test group passed: 3 files, 19 tests.

### Phase 1 changes

- Corrected the stale comment in `src/core/tools/toolsets.ts` so it accurately describes guarded artifact writes versus prohibited code edits and arbitrary shell execution.
- Added a registry regression test ensuring each tier toolset has unique tool names.
- Bumped package version to `1.13.68` and recorded the changes in `CHANGELOG.md`.
- `bun run build` passed with TypeScript compilation at version `1.13.68`.

### Phase 2 changes — edit-tool schema cleanup

- Removed the redundant `AllowMultiple` alias property from the public schemas for `replace_file_content` and `multi_replace_file_content`, including nested batch schemas. The canonical `allowMultiple` remains documented.
- Kept runtime compatibility handling for legacy `AllowMultiple` inputs; no execution behavior or tool names changed.
- Added a regression test confirming the duplicate schema alias is absent while legacy compatibility handling remains present.
- Focused tests passed: 3 files, 21 tests. Build and diff validation are run before committing this phase.
- Bumped package version to `1.13.69` and recorded the schema cleanup in `CHANGELOG.md`.

### Deferred work and risks

- No tool consolidation, alias removal, staged tool discovery, or MCP default-policy change was made. Those changes require action-by-action compatibility tests and reliable usage data first.
- The token figures are approximate `cl100k_base` estimates for serialized tool definitions, not guaranteed provider-billed tokens or the exact API payload. Keep this baseline for directional comparison only.
- Edit-tool consolidation audit completed against `fileEditTools.ts` and existing local/SSH/concurrency/allowlist tests. `replace_file_content` supports a batch of independent edits grouped by file; `multi_replace_file_content` supports multiple non-contiguous chunks per file and rejects overlapping resolved line ranges. Their SSH routes also differ: one routes each edit via `sshEditToolExecute`, the other uses `sshMultiEditToolExecute`, with distinct validation and line-range semantics.
- Decision: do not merge these public tools yet. A unified schema would need to preserve both batch shapes, overlap detection, legacy argument aliases, line-ending behavior, SSH behavior, per-file locking, optimistic concurrency checks, and Master write allowlisting. The focused regression group passed 27/27 tests across four files.
- Shell-tool consolidation audit completed in `src/core/tools/shellTools.ts`. Both tools share much of the foreground process lifecycle (abort, timeout, output logging, interactive-prompt detection), but they are not behavior-equivalent: `run_command` supports caller-selected cwd, adjusts occupied ports, serializes package installs with an npm lock, normalizes Windows package-runner commands, and has more specific timeout/reporter guidance. `bash` uses the supplied runtime cwd, has different Windows command normalization, and its SSH branch defaults to the remote workspace cwd.
- Shell regression group passed 16/16 tests across four files (`terminalCommand`, `shellToolsPortLock`, `sshProxyExecCommand`, `commandLogger`).
- Decision: do not alias one shell tool to the other or merge them at the public-schema level yet. A safer future optimization is to extract the shared process lifecycle into a private helper while preserving distinct command preparation, cwd, port, install-lock, and SSH policies. This refactor needs focused parity tests before any public tool removal.
- Browser-tool audit completed against `toolsets.ts`, `chromeCdpTools.ts`, extension-backed browser tools, vision automation, screenshot tools, and existing tests. `control_chrome_cdp` controls real Chrome over CDP port 9222; extension-backed tools depend on a separate WebSocket bridge at 9223; `control_chrome_vision` depends on UI-DETR at port 8095; `screenshot` captures the OS desktop; `playwright_screenshot` launches a browser engine against a supplied URL. These are different execution surfaces, not interchangeable aliases.
- Removed 14 synonymous/legacy command names from the public `control_chrome_cdp` enum while retaining their dispatcher cases for compatibility. Kept commands with distinct behavior such as `drag` and separate cursor controls. Added a schema regression test; existing runtime tests continue to exercise legacy `drag`, `set_device`, and `set_viewport` commands.
- Chrome profile/process audit: listing configured profiles reads local Chrome metadata; listing running Chrome enumerates processes and windows; launching Chrome starts a profile; `close_chrome_profile` terminates a shared browser process and may close windows across profiles, while `close_chrome_window` uses a separate graceful Windows window-close path. Do not merge these tools into one public action contract without first preserving and emphasizing the different blast radius.
- Focused browser regression group passed 102/102 tests across four files (`chromeCdpTools`, `extensionChatToolFilter`, `chromeProfileTools`, `chromeProcessTools`).
- Next: run build and diff validation, commit this schema cleanup, then audit process-inspection tools for genuine overlap versus safe/destructive action boundaries.
