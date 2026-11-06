# SAFOLDER1 folder package — Worker B, 2026-11-06

## Files and contract

New: src/core/lanRemote/folderPackage.ts, apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/LanFolderPackage.java, tests/lanFolderPackage.test.ts, this report.

The ASCII literal SAFOLDER1 is **9 bytes** despite the brief calling it 8. Both implementations use nine bytes, followed by a four-byte unsigned big-endian manifest length (1..32768), UTF-8 JSON {version:1,files:[{path,size,sha256}]}, then raw file bytes in manifest array order. The TypeScript packer sorts paths lexicographically and emits stable key ordering. Each SHA-256 covers exactly one file's bytes. Limits: 1–64 files, at most 8 nested folder levels, max 32 KiB manifest, 4 MiB *total* including header, manifest and payload. Empty files are allowed; empty directories are not representable and are rejected.

Readers fully validate header, lengths, version, keys, strict UTF-8, sizes, duplicate/case-colliding paths, file/directory collisions, path components, hashes, and trailing bytes. They reject absolute, drive, backslash, traversal, Unicode, control characters, symlinks on packaging, hidden/sensitive and Windows device basenames. A selected hidden/sensitive root is also rejected. Only regular files are packaged.

## Integration APIs

TypeScript exports:
- packFolder(root: string): Promise<Buffer> — locally selected directory to transferable archive bytes
- inspectFolderPackage(bytes: Uint8Array): FolderManifest — complete validation without write
- unpackFolderPackage(bytes: Uint8Array, outputDirectory: string): Promise<UnpackedFolder> — existing, non-symlink destination parent; creates a unique private child with exclusive-create files, cleans up on failure
- validateFolderRelativePath(path: unknown): string
- FOLDER_MAGIC, FOLDER_PACKAGE_MAX_BYTES, FOLDER_MANIFEST_MAX_BYTES, FOLDER_MAX_FILES and FOLDER_MAX_NESTED_LEVELS

Android Java:
- LanFolderPackage.inspect(byte[]): Inspection — immutable entries with path, size, sha256 and payload offset
- LanFolderPackage.extract(Context, byte[]): Extraction — validates before writing via Android MediaStore to Download/SuperAgent LAN/Folder-UUID/<relative path>; returns relativeDirectory and created URIs for revocation cleanup. Publishes only after all writes, attempts cleanup if any fail. Requires Android API 29+.

Sender: explicitly selected local folder, optionally save archive under a safe .safolder basename, transfer as *one* existing 4 MiB/4096-byte chunked file. Receiver: after existing owner-approved transfer and outer hash verification, inspect and extract to owner-controlled destination; no remote-selected output path. Android caller remains responsible for physical approval and any post-extraction revocation cleanup. Pinned TLS + pairing + segment-filtered discovery + separate physical approval remain outside this module and MUST NOT be bypassed.

Cross-owner note: Tray's new WebView folder picker currently restricts relative paths to 240 characters while the TypeScript/Java manifest readers allow up to 900; sender may reject otherwise parseable safe paths. Harmonize only in owner files or document the tighter Tray sender limit. Do not infer that a network segment is an authorization credential.

## Validation

- bun --bun x vitest run tests/lanFolderPackage.test.ts: PASS 8/8.
- bun --bun x tsc --noEmit: PASS.
- ./gradlew :app:compileDebugJavaWithJavac --rerun-tasks --offline: BUILD SUCCESSFUL (Java compiler executed).
- Combined run of lanFolderPackage, lanFileTransfer, androidLanFileContract: 19 passed, 2 failed. The first 15 (8 package + 7 transfer) pass; 2 failing legacy Android contract source-string checks are outside Worker B scope. One expects literal 'synchronized void clear()' although current LanFileExchange uses atomic revocation plus internal synchronization. The other expects a literal inline lan_file_save invocation although Tray now passes a selected command name to a common native invoke call. The relevant owners should update contracts after semantic review; no out-of-scope changes applied.

Not independently tested: physical Android/Windows round-trip, on-device MediaStore persistence, UI approval behavior, network-segment filtering or mobile folder-source picker.
