# LAN Tray folder UX worker report — 2026-11-06

## Scope and checkout
- Registered project `superagent`; branch `main`; shared checkout. No new worktree, branch, commit, push, service restart, Chrome lifecycle, or tunnel mutation.
- Owned changes: `apps/superagent-tray/ui/lan-file-transfer.js`, `apps/superagent-tray/ui/index.html`, `apps/superagent-tray/ui/lan-devices.css`, and new `tests/desktopTrayLanFolderUi.test.ts`.
- Concurrent existing `index.html` changes were preserved via surgical replacements. No edits to `lan-devices.js`, native Rust, backend or Android.

## UX and binary protocol
- `lan-folder-source` is a native WebKit `<input type="file" webkitdirectory multiple>`; `lan-folder-send` is disabled if WebView does not actually expose directory-selection support or if no approved LAN session.
- Only user-selected directory entries may be sent; 1–64 files, safe ASCII relative paths, no hidden components, traversal, reserved Windows device names, case-insensitive collisions, file/directory prefix collisions or mixed roots. Up to 4 MiB **including** the archive header, JSON manifest, and file bytes.
- Archive bytes: 9 ASCII bytes `SAFOLDER1`, then `uint32` big-endian manifest JSON byte length, then UTF-8 `{"version":1,"files":[{"path":"root/example.txt","size":3,"sha256":"..."}]}`, then concatenated raw file bytes in manifest order. Entries sorted by original case-sensitive path. Individual file SHA-256 and full archive SHA-256 are calculated before `file_offer`.
- Existing `file_offer`/4096-byte `file_put`/ `file_finish` flow is used without new transfer actions; target must separately approve. Existing individual file send/receive remains available.
- On download with name ending in `.safolder`, validate header, bounded UTF-8 manifest, version/shape, 1–64 safe paths and hashes, exact payload boundaries and no trailing bytes, before invoking native `lan_folder_save` with exactly `{name,data,sha256}` where `data` is the Base64 of entire archive. Never pass a folder package to `lan_file_save`.
- Native command must ask user to pick destination, revalidate every file/path/hash, enforce create-only writes with no overwrites or symlink escapes, and fail closed on cancellations/errors; this is orchestrator-owned and not implemented by this worker.

## Segment discovery integration contract
- `index.html` now has `#lan-segment-name` adjacent to `#lan-discovery-scan`, HTML `required`, `minlength=3`, `maxlength=32`, pattern `[A-Za-z0-9][A-Za-z0-9 _.-]{2,31}`.
- Orchestrator-owned `lan-devices.js` already contains a scan handler using `invoke("discover", {segment})`, rejects missing/invalid segment and clears old results on edits. It currently trims only; **orchestrator should normalize consistently** with all native clients and network discovery (e.g. trim and canonical case if that is the shared protocol), and must enforce matching segment on every returned device. Do not treat segment as authentication: preserve pinned TLS certificate + physical device approval. A missing segment must NEVER scan globally.
- Segment names containing spaces/dots are accepted by the current orchestrator handler; UI pattern is aligned with that handler. HTML alone is not security enforcement.

## Verified isolated checks
`node --check apps/superagent-tray/ui/lan-file-transfer.js` — PASS.
`bunx vitest run tests/desktopTrayLanFolderUi.test.ts tests/desktopTrayLanFilesUi.test.ts tests/desktopTrayLanUi.test.ts` — **32/32 PASS** (23 new folder, 4 existing file, 5 existing LAN UI).
`bunx tsc --noEmit` — PASS.
No physical Android/Windows LAN E2E, native folder picker, native extraction or live network scan was run.

## Remaining integration work
1. Orchestrator/native: wire `lan_folder_save` exactly as above and atomic fail-closed create-only extraction.
2. Windows and Android clients: consented sending/receiving of `.safolder` via existing offer/chunks with matching path/archive rules. Do not flatten paths, auto-extract, or overwrite.
3. Native discovery and clients: require matching normalized segment before discovery; keep TLS pinning and local approval as authorization.
4. End-to-end test on both client platforms and native Tauri WebView, including dialog cancel and unsupported `webkitdirectory`.
