"use strict";
/**
 * Explicit owner-selected LAN file/folder exchange.
 * Folders are bounded SAFOLDER1 archives, never filesystem paths or silent overwrites.
 * The target still approves every offered transfer and TLS remains fingerprint-pinned.
 */
(() => {
  const MAX = 4 * 1024 * 1024;
  const CHUNK = 4096;
  const MAX_FILES = 64;
  const MAX_MANIFEST = 32768;
  const MAGIC = "SAFOLDER1";
  const HEADER = 13; // 9 ASCII bytes + uint32 big-endian JSON length
  const $ = (id) => document.getElementById(id);
  let busy = false;
  let cancelled = false;
  let activeTransfer = null;
  let targetId = null;
  const selected = () => {
    const device = window.__superagentLanGetSelected?.();
    return device?.connected ? device : null;
  };
  function state(message, progress = null) {
    if ($("lan-file-state")) $("lan-file-state").textContent = String(message).slice(0, 90);
    if ($("lan-file-info")) $("lan-file-info").textContent = String(message).slice(0, 300);
    if (progress !== null && $("lan-file-progress")) $("lan-file-progress").value = Math.max(0, Math.min(100, progress));
  }
  // Explicitly check WebKit directory-picking support. Never pretend an ordinary
  // multi-file selection represents a folder or silently flatten its structure.
  const folderSupported = () => {
    const input = $("lan-folder-source");
    return Boolean(input && "webkitdirectory" in input && input.webkitdirectory === true && input.multiple === true);
  };
  function controls() {
    const hasDevice = Boolean(selected());
    const file = $("lan-file-source")?.files?.[0];
    const folder = $("lan-folder-source");
    if ($("lan-file-send")) $("lan-file-send").disabled = busy || !hasDevice || !file;
    if ($("lan-folder-send")) $("lan-folder-send").disabled =
      busy || !hasDevice || !folderSupported() || !folder?.files?.length;
    if ($("lan-file-receive")) $("lan-file-receive").disabled = busy || !hasDevice;
    if ($("lan-file-cancel")) $("lan-file-cancel").disabled = !busy;
    if ($("lan-file-source")) $("lan-file-source").disabled = busy;
    if (folder) folder.disabled = busy || !folderSupported();
    if ($("lan-folder-support")) $("lan-folder-support").textContent = folderSupported()
      ? "Choose one folder. Up to 64 files and 4 MiB total (including package overhead). Hidden files and unsafe paths are blocked."
      : "Folder picking is not supported in this WebView; folder sending is disabled.";
  }
  async function invoke(action, payload = {}) {
    const fn = window.__TAURI__?.core?.invoke;
    if (typeof fn !== "function") throw Error("This feature requires the SuperAgent Tray native application.");
    const result = await fn("lan_support_action", { action, payload });
    if (!result || result.success !== true) throw Error("File transfer request was rejected.");
    return result;
  }
  const hash = async (bytes) => {
    if (!crypto?.subtle?.digest) throw Error("Secure browser SHA-256 is unavailable.");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join("");
  };
  const base64 = (bytes) => btoa(String.fromCharCode(...bytes));
  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    }
    return btoa(binary);
  }
  const filenameAllowed = (name) => typeof name === "string"
    && /^[A-Za-z0-9_][A-Za-z0-9_ .()-]{0,95}$/.test(name)
    && !name.endsWith(".") && !name.endsWith(" ");
  // Windows reserves device names even when a file extension follows.
  const sensitive = /(?:^|[_ .(-])(?:secret|secrets|password|passwords|passwd|credential|credentials|private|token|tokens|apikey|api-key|accesskey|access-key|id_rsa|id_dsa|id_ecdsa|id_ed25519|keystore|wallet|recovery|seedphrase)(?:$|[_ .)-])/i;
  const sensitiveSuffix = /\.(?:pem|key|p12|pfx|jks|kdbx|asc)$/i;
  const reserved = (part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
    .test(part.split(".")[0].trimEnd());
  function safePath(path, maxParts = 9) {
    if (typeof path !== "string" || !path.length || path.length > 240 ||
        path.includes("\\") || path.includes(":") || path.startsWith("/") ||
        path.includes("\u0000")) return false;
    const parts = path.split("/");
    return parts.length <= maxParts && parts.every((part) =>
      filenameAllowed(part) && part !== "." && part !== ".." &&
      !part.startsWith(".") && !reserved(part) && !sensitive.test(part)
      && !sensitiveSuffix.test(part));
  }
  function assertActive() {
    if (cancelled || !busy || !selected() || selected().id !== targetId) {
      throw Error("File transfer cancelled or approved LAN session ended.");
    }
  }
  async function abortIfNeeded() {
    if (!activeTransfer || !targetId) return;
    try { await invoke("file_abort", { deviceId: targetId, transferId: activeTransfer }); }
    catch { /* Session revoke is also a valid cleanup path. */ }
  }

  async function packageFolder(files) {
    if (!folderSupported()) throw Error("Directory selection is unsupported by this WebView.");
    if (!files.length || files.length > MAX_FILES) throw Error("Select a folder with 1–64 regular files.");
    const selectedFiles = [];
    const seen = new Set();
    let root = null;
    let total = 0;
    for (const file of files) {
      const path = file.webkitRelativePath;
      if (!safePath(path, 10) || !path.includes("/")) throw Error("Folder has an unsafe or missing relative path.");
      const first = path.split("/")[0];
      if (root === null) root = first;
      if (first !== root) throw Error("Choose exactly one folder.");
      // Folder package paths are RELATIVE to its selected root. The root
      // itself is carried in the .safolder filename, not duplicated inside.
      const relative = path.slice(first.length + 1);
      if (!safePath(relative, 9)) throw Error("Unsafe nested folder path.");
      const canonical = relative.toLowerCase();
      if ([...seen].some((existing) => canonical === existing ||
          canonical.startsWith(existing + "/") || existing.startsWith(canonical + "/")))
        throw Error("Folder contains conflicting or case-colliding paths.");
      seen.add(canonical);
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX)
        throw Error("Folder contains an invalid or oversized file.");
      total += file.size;
      if (total >= MAX) throw Error("Folder exceeds the 4 MiB archive limit including overhead.");
      selectedFiles.push({ file, path: relative });
    }
    selectedFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const entries = [];
    const payloads = [];
    for (const entry of selectedFiles) {
      assertActive();
      const bytes = new Uint8Array(await entry.file.arrayBuffer());
      if (bytes.length !== entry.file.size) throw Error("A selected file changed while reading.");
      entries.push({ path: entry.path, size: bytes.length, sha256: await hash(bytes) });
      payloads.push(bytes);
    }
    const manifest = new TextEncoder().encode(JSON.stringify({ version: 1, files: entries }));
    const archiveLength = HEADER + manifest.length + total;
    if (manifest.length === 0 || manifest.length > MAX_MANIFEST || archiveLength > MAX)
      throw Error("Folder archive exceeds the 4 MiB limit including its manifest.");
    const archive = new Uint8Array(archiveLength);
    for (let i = 0; i < MAGIC.length; i++) archive[i] = MAGIC.charCodeAt(i);
    new DataView(archive.buffer).setUint32(MAGIC.length, manifest.length, false);
    archive.set(manifest, HEADER);
    let offset = HEADER + manifest.length;
    for (const payload of payloads) { archive.set(payload, offset); offset += payload.length; }
    const name = root + ".safolder";
    if (!filenameAllowed(name) || reserved(name))
      throw Error("Selected folder name cannot be sent as a safe .safolder filename.");
    return { name, bytes: archive, count: entries.length };
  }

  async function validateFolderArchive(bytes) {
    if (bytes.length < HEADER + 2 || bytes.length > MAX ||
        Array.from(bytes.subarray(0, MAGIC.length), (b) => String.fromCharCode(b)).join("") !== MAGIC)
      throw Error("Invalid SAFOLDER1 archive magic or length.");
    const manifestSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      .getUint32(MAGIC.length, false);
    if (manifestSize < 2 || manifestSize > MAX_MANIFEST || HEADER + manifestSize > bytes.length)
      throw Error("Invalid folder manifest size.");
    let manifest;
    try {
      const json = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes.subarray(HEADER, HEADER + manifestSize));
      manifest = JSON.parse(json);
    } catch { throw Error("Folder manifest is not valid UTF-8 JSON."); }
    if (!manifest || Array.isArray(manifest) || typeof manifest !== "object" ||
        Object.keys(manifest).sort().join(",") !== "files,version" ||
        manifest.version !== 1 || !Array.isArray(manifest.files) ||
        manifest.files.length < 1 || manifest.files.length > MAX_FILES)
      throw Error("Unsupported folder manifest.");
    const seen = new Set();
    let offset = HEADER + manifestSize;
    for (const entry of manifest.files) {
      if (!entry || Array.isArray(entry) || typeof entry !== "object" ||
          Object.keys(entry).sort().join(",") !== "path,sha256,size" ||
          !safePath(entry.path) || !Number.isSafeInteger(entry.size) ||
          entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256))
        throw Error("Folder manifest contains invalid file metadata or unsafe path.");
      const canonical = entry.path.toLowerCase();
      if ([...seen].some((existing) => canonical === existing ||
          canonical.startsWith(existing + "/") || existing.startsWith(canonical + "/")))
        throw Error("Folder manifest contains conflicting paths.");
      seen.add(canonical);
      if (entry.size > bytes.length - offset) throw Error("Folder entry exceeds archive bounds.");
      if (await hash(bytes.subarray(offset, offset + entry.size)) !== entry.sha256)
        throw Error("Folder entry SHA-256 mismatch: " + entry.path);
      offset += entry.size;
    }
    if (offset !== bytes.length) throw Error("Folder archive contains unexpected trailing bytes.");
    return manifest;
  }

  async function sendBuffer(device, name, bytes, successText) {
    assertActive();
    const sha256 = await hash(bytes);
    assertActive();
    state("Waiting for the device owner to approve receiving " + name, 0);
    const offer = (await invoke("file_offer", { deviceId: targetId,
      direction: "upload", name, size: bytes.length, sha256 })).file;
    if (!offer || offer.name !== name || offer.size !== bytes.length ||
        offer.sha256 !== sha256 || offer.chunkBytes !== CHUNK ||
        typeof offer.transferId !== "string") throw Error("Target file metadata mismatch.");
    activeTransfer = offer.transferId;
    for (let offset = 0, seq = 0; offset < bytes.length; offset += CHUNK, seq++) {
      assertActive();
      const data = base64(bytes.subarray(offset, offset + CHUNK));
      const result = (await invoke("file_put", { deviceId: targetId,
        transferId: activeTransfer, seq, data })).result;
      if (!result || result.seq !== seq + 1 ||
          result.received !== Math.min(offset + CHUNK, bytes.length))
        throw Error("Target chunk confirmation mismatch.");
      state("Sending " + name + " · " + result.received + "/" + bytes.length + " bytes",
        100 * result.received / bytes.length);
    }
    assertActive();
    const committed = (await invoke("file_finish", { deviceId: targetId,
      transferId: activeTransfer })).result;
    if (!committed?.ok || committed.bytes !== bytes.length)
      throw Error("Target did not verify and save all bytes.");
    activeTransfer = null;
    return successText || ("File sent, SHA-256 verified on target. Saved to: " +
      (committed.savedTo || "the target's approved Downloads folder"));
  }
  async function send() {
    if (busy) return;
    const device = selected();
    const file = $("lan-file-source")?.files?.[0];
    if (!device || !file) return;
    if (!filenameAllowed(file.name) || file.size < 1 || file.size > MAX) {
      state("Only regular files with safe ASCII names, 1 byte–4 MiB, can be transferred.");
      return;
    }
    if (!window.confirm("Send " + file.name + " (" + file.size + " bytes) to " +
      device.label + "? The target owner must approve this file individually.")) return;
    busy = true; cancelled = false; targetId = device.id; activeTransfer = null;
    controls();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length !== file.size) throw Error("Local file changed during selection.");
      const message = await sendBuffer(device, file.name, bytes);
      if ($("lan-file-source")) $("lan-file-source").value = "";
      state(message, 100);
    } catch (error) {
      await abortIfNeeded();
      state("Send failed: " + String(error).slice(0, 200));
    } finally {
      activeTransfer = null; busy = false; cancelled = false; targetId = null; controls();
    }
  }
  async function sendFolder() {
    if (busy) return;
    const device = selected();
    const input = $("lan-folder-source");
    if (!device || !input) return;
    if (!folderSupported()) { state("Directory picker is unavailable; folder transfer disabled."); return; }
    const files = Array.from(input.files || []);
    if (files.length < 1 || files.length > MAX_FILES) {
      state("Select a directory containing 1–64 files."); return;
    }
    if (!window.confirm("Package " + files.length + " owner-selected files into one .safolder and send to " +
      device.label + "? The target owner must approve this folder transfer.")) return;
    busy = true; cancelled = false; targetId = device.id; activeTransfer = null;
    controls();
    try {
      state("Checking safe relative paths and SHA-256 hashes...", 0);
      const archive = await packageFolder(files);
      const message = await sendBuffer(device, archive.name, archive.bytes,
        "Folder package sent (" + archive.count + " files), SHA-256 verified on target. " +
        "The receiving client must explicitly extract using its safe folder destination flow.");
      input.value = "";
      state(message, 100);
    } catch (error) {
      await abortIfNeeded();
      state("Folder send failed: " + String(error).slice(0, 200));
    } finally {
      activeTransfer = null; busy = false; cancelled = false; targetId = null; controls();
    }
  }
  async function receive() {
    if (busy) return;
    const device = selected();
    if (!device) return;
    if (!window.confirm("Request the file or folder that the " + device.platform +
      " owner explicitly selected for sharing? The owner must approve this transfer.")) return;
    busy = true; cancelled = false; targetId = device.id; activeTransfer = null;
    controls();
    try {
      state("Requesting target owner's approval to send their selected file", 0);
      const offer = (await invoke("file_offer", {
        deviceId: targetId, direction: "download",
      })).file;
      if (!offer || !filenameAllowed(offer.name) ||
          !Number.isInteger(offer.size) || offer.size < 1 || offer.size > MAX ||
          typeof offer.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(offer.sha256) ||
          offer.chunkBytes !== CHUNK || typeof offer.transferId !== "string")
        throw Error("Target returned invalid file metadata.");
      activeTransfer = offer.transferId;
      const received = new Uint8Array(offer.size);
      for (let offset = 0, seq = 0; offset < offer.size; offset += CHUNK, seq++) {
        assertActive();
        const reply = (await invoke("file_get", { deviceId: targetId,
          transferId: activeTransfer, seq })).result;
        if (!reply || reply.seq !== seq || typeof reply.data !== "string" ||
            reply.data.length > 5464 || !/^[A-Za-z0-9+/]+={0,2}$/.test(reply.data))
          throw Error("Malformed file chunk.");
        const raw = atob(reply.data);
        if (!raw.length || raw.length > CHUNK ||
            offset + raw.length > offer.size || reply.received !== offset + raw.length)
          throw Error("Invalid file size/sequence in received chunk.");
        for (let i = 0; i < raw.length; i++) received[offset + i] = raw.charCodeAt(i);
        state("Receiving " + offer.name + " · " + (offset + raw.length) + "/" + offer.size + " bytes",
          (offset + raw.length) / offer.size * 100);
      }
      assertActive();
      if (await hash(received) !== offer.sha256) throw Error("SHA-256 verification failed.");
      const isFolder = offer.name.toLowerCase().endsWith(".safolder");
      const manifest = isFolder ? await validateFolderArchive(received) : null;
      assertActive();
      const commit = (await invoke("file_finish", { deviceId: targetId,
        transferId: activeTransfer })).result;
      if (!commit?.ok || commit.bytes !== offer.size) throw Error("Target did not finalize transfer.");
      activeTransfer = null;
      const name = isFolder ? "lan_folder_save" : "lan_file_save";
      state(isFolder ? "Folder verified. Choose a new output folder in the native dialog."
        : "File verified. Choose a local destination in the native Save As dialog.", 100);
      // Native picker chooses the destination. Never pass remote-supplied paths
      // as filesystem destinations; Rust must revalidate and create-only write.
      const saved = await window.__TAURI__.core.invoke(name, {
        name: offer.name, data: bytesToBase64(received), sha256: offer.sha256,
      });
      state(saved?.saved
        ? (isFolder ? "Folder received and verified (" + manifest.files.length + " files)." :
          "File received and saved after SHA-256 verification.")
        : (isFolder ? "Folder received, but destination selection was cancelled; nothing was written." :
          "File received, but Save As was cancelled; nothing was written."), 100);
    } catch (error) {
      await abortIfNeeded();
      state("Receive failed: " + String(error).slice(0, 200));
    } finally {
      activeTransfer = null; busy = false; cancelled = false; targetId = null; controls();
    }
  }
  function install() {
    $("lan-file-source")?.addEventListener("change", controls);
    $("lan-folder-source")?.addEventListener("change", controls);
    $("lan-file-send")?.addEventListener("click", () => { void send(); });
    $("lan-folder-send")?.addEventListener("click", () => { void sendFolder(); });
    $("lan-file-receive")?.addEventListener("click", () => { void receive(); });
    $("lan-file-cancel")?.addEventListener("click", () => {
      cancelled = true;
      state("Cancelling file transfer; waiting for the current network chunk to finish.");
      void abortIfNeeded();
    });
    window.__superagentLanFilesRefresh = controls;
    controls();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
