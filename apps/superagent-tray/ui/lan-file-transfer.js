"use strict";
/**
 * Explicit owner-selected LAN file/folder exchange.
 * Folders are bounded SAFOLDER1 archives, never filesystem paths or silent overwrites.
 * The target still approves every offered transfer and TLS remains fingerprint-pinned.
 */
(() => {
  const MAX = 4 * 1024 * 1024;
  const V2_MAX = 256 * 1024 * 1024;
  const V2_CHUNK = 16 * 1024;
  const CHUNK = 4096;
  const MAX_FILES = 64;
  const MAX_QUEUE_FILES = 32;
  const MAX_MANIFEST = 32768;
  const MAGIC = "SAFOLDER1";
  const HEADER = 13; // 9 ASCII bytes + uint32 big-endian JSON length
  const $ = (id) => document.getElementById(id);
  const notifyTransfer = (kind, message) => window.TrayFeedback?.notify({
    kind, message, scope: "lan-devices",
  });
  let busy = false;
  let cancelled = false;
  let activeTransfer = null;
  let activeProtocol = 1;
  let sendingMany = false;
  let retryPlan = null;
  let transferStartTime = 0;
  let targetId = null;
  let batch = null;
  let paused = false;
  let resumeWake = null;
  const recent = [];
  function receipt(direction, filename, bytes, outcome) {
    recent.unshift({ direction, filename, bytes, outcome });
    if (recent.length > 6) recent.length = 6;
    const el = $("lan-file-history");
    if (el) el.textContent = recent.map((item) =>
      item.direction + " · " + item.filename + " · " + item.bytes +
      " bytes · " + item.outcome).join("\n");
  }
  function wake() {
    const resolve = resumeWake;
    resumeWake = null;
    if (resolve) resolve();
  }
  async function waitIfPaused() {
    assertActive();
    while (paused) {
      await new Promise((resolve) => { resumeWake = resolve; });
      assertActive();
    }
  }
  const selected = () => {
    const device = window.__superagentLanGetSelected?.();
    return device?.connected ? device : null;
  };
  function metrics(bytes, size, prefix = "") {
    const time = Math.max(1, Date.now() - transferStartTime) / 1000;
    const speed = bytes / time;
    const eta = speed > 0 ? Math.ceil((size - bytes) / speed) : 0;
    const label = $("lan-file-metrics");
    if (label) label.textContent = prefix + bytes + "/" + size + " bytes · " +
      (speed / 1024).toFixed(1) + " KiB/s · ETA " + eta + "s";
  }
  function state(message, progress = null) {
    const visible = paused && !String(message).startsWith("Paused") && progress !== null
      ? "Paused · " + String(message) : String(message);
    if ($("lan-file-state")) $("lan-file-state").textContent = visible.slice(0, 90);
    if ($("lan-file-info")) $("lan-file-info").textContent = visible.slice(0, 300);
    if (progress !== null && $("lan-file-progress")) {
      const overall = batch ? (batch.index + progress / 100) * 100 / batch.total : progress;
      $("lan-file-progress").value = Math.max(0, Math.min(100, overall));
    }
  }
  // Explicitly check WebKit directory-picking support. Never pretend an ordinary
  // multi-file selection represents a folder or silently flatten its structure.
  const folderSupported = () => {
    const input = $("lan-folder-source");
    return Boolean(input && "webkitdirectory" in input && input.webkitdirectory === true && input.multiple === true);
  };
  function controls() {
    const hasDevice = Boolean(selected());
    const files = $("lan-file-source")?.files;
    const folder = $("lan-folder-source");
    if ($("lan-file-send")) $("lan-file-send").disabled = busy || !hasDevice || !files?.length;
    if ($("lan-file-retry")) $("lan-file-retry").disabled = busy || !hasDevice || !retryPlan;
    if ($("lan-folder-send")) $("lan-folder-send").disabled =
      busy || !hasDevice || !folderSupported() || !folder?.files?.length;
    if ($("lan-file-receive")) $("lan-file-receive").disabled = busy || !hasDevice;
    if ($("lan-file-cancel")) $("lan-file-cancel").disabled = !busy;
    if ($("lan-file-pause")) {
      $("lan-file-pause").disabled = !busy || !activeTransfer || cancelled;
      $("lan-file-pause").textContent = paused ? "Resume transfer" : "Pause transfer";
    }
    if ($("lan-file-source")) $("lan-file-source").disabled = busy;
    if ($("lan-file-send-all")) $("lan-file-send-all").disabled = busy || !hasDevice;
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
  async function checkpoint(direction, name, size, sha256) {
    assertActive();
    const result = (await invoke("file_status", {
      deviceId: targetId, transferId: activeTransfer,
    })).result;
    if (!result || result.transferId !== activeTransfer || result.direction !== direction ||
        result.name !== name || result.size !== size || result.sha256 !== sha256 ||
        !Number.isInteger(result.seq) || result.seq < 0 ||
        !Number.isInteger(result.received) || result.received < 0 || result.received > size) {
      throw Error("Transfer checkpoint does not match the approved file.");
    }
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
    const current = sendingMany
      ? window.__superagentLanListTransferTargets?.()?.some((d) => d.connected && d.id === targetId)
      : selected()?.id === targetId;
    if (cancelled || !busy || !current) {
      throw Error("File transfer cancelled or approved LAN session ended.");
    }
  }
  async function abortIfNeeded() {
    if (!activeTransfer || !targetId) return;
    try { await invoke(activeProtocol === 2 ? "file_v2_abort" : "file_abort",
      { deviceId: targetId, transferId: activeTransfer }); }
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
    activeProtocol = 1;
    transferStartTime = Date.now();
    controls();
    for (let offset = 0, seq = 0; offset < bytes.length; offset += CHUNK, seq++) {
      await waitIfPaused();
      assertActive();
      const data = base64(bytes.subarray(offset, offset + CHUNK));
      let result;
      try {
        result = (await invoke("file_put", { deviceId: targetId,
          transferId: activeTransfer, seq, data })).result;
      } catch (error) {
        // A transport reply may be lost after the target committed a chunk.
        // Query the authenticated checkpoint rather than blindly replaying
        // an ambiguous mutating request.
        const remote = await checkpoint("upload", name, bytes.length, sha256);
        if (remote.seq !== seq + 1 ||
            remote.received !== Math.min(offset + CHUNK, bytes.length)) throw error;
        result = { seq: remote.seq, received: remote.received };
      }
      if (!result || result.seq !== seq + 1 ||
          result.received !== Math.min(offset + CHUNK, bytes.length))
        throw Error("Target chunk confirmation mismatch.");
      metrics(result.received, bytes.length);
      state("Sending " + name + " · " + result.received + "/" + bytes.length + " bytes",
        100 * result.received / bytes.length);
    }
    assertActive();
    const committed = (await invoke("file_finish", { deviceId: targetId,
      transferId: activeTransfer })).result;
    if (!committed?.ok || committed.bytes !== bytes.length)
      throw Error("Target did not verify and save all bytes.");
    activeTransfer = null;
    controls();
    receipt("Sent", name, bytes.length, "Verified");
    return successText || ("File sent, SHA-256 verified on target. Saved to: " +
      (committed.savedTo || "the target's approved Downloads folder"));
  }
  async function hashLargeFile(file) {
    const Constructor = window.LanStreamingSha256;
    if (typeof Constructor !== "function" || typeof file?.slice !== "function")
      throw Error("Streaming SHA-256 unavailable; update the Tray to send files above 4 MiB.");
    const hasher = new Constructor();
    for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
      assertActive();
      const part = new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer());
      if (!part.length || part.length > 1024 * 1024)
        throw Error("Selected file became unreadable while hashing.");
      hasher.update(part);
      state("Calculating streaming SHA-256 for " + file.name + " · " +
        Math.min(offset + part.length, file.size) + "/" + file.size + " bytes", 0);
    }
    return hasher.hex();
  }
  async function largeCheckpoint(file, sha256) {
    assertActive();
    const result = (await invoke("file_v2_status", {
      deviceId: targetId, transferId: activeTransfer,
    })).result;
    if (!result || result.transferId !== activeTransfer || result.direction !== "upload" ||
        result.name !== file.name || result.size !== file.size || result.sha256 !== sha256 ||
        !Number.isSafeInteger(result.seq) || !Number.isSafeInteger(result.received) ||
        result.received < 0 || result.received > file.size ||
        result.seq !== Math.ceil(result.received / V2_CHUNK) ||
        (result.received % V2_CHUNK !== 0 && result.received !== file.size))
      throw Error("V2 target checkpoint does not match the selected file.");
    return result;
  }
  async function sendLargeFile(device, file) {
    if (device.platform !== "windows" && device.platform !== "android")
      throw Error("V2 disk-backed upload requires updated Windows or Android LAN client.");
    if (file.size <= MAX || file.size > V2_MAX || file.name.endsWith(".safolder"))
      throw Error("Large folder archives or invalid V2 file size are not supported.");
    const sha256 = await hashLargeFile(file);
    assertActive();
    state("Waiting for " + device.platform + " owner approval to receive large file " + file.name, 0);
    const offer = (await invoke("file_v2_offer", {
      deviceId: targetId, direction: "upload", name: file.name, size: file.size, sha256,
    })).file;
    if (!offer || offer.version !== undefined && offer.version !== 2 ||
        offer.name !== file.name || offer.size !== file.size || offer.sha256 !== sha256 ||
        offer.chunkBytes !== V2_CHUNK || typeof offer.transferId !== "string" ||
        !Number.isSafeInteger(offer.received) || !Number.isSafeInteger(offer.seq) ||
        offer.received < 0 || offer.received > file.size ||
        offer.seq !== Math.ceil(offer.received / V2_CHUNK) ||
        (offer.received % V2_CHUNK !== 0 && offer.received !== file.size))
      throw Error("Invalid V2 negotiated offer or restart checkpoint.");
    activeProtocol = 2;
    activeTransfer = offer.transferId;
    transferStartTime = Date.now();
    controls();
    for (let offset = offer.received, seq = offer.seq; offset < file.size; seq++) {
      await waitIfPaused();
      const raw = new Uint8Array(await file.slice(offset, offset + V2_CHUNK).arrayBuffer());
      assertActive();
      if (!raw.length || raw.length > V2_CHUNK || (raw.length !== V2_CHUNK && offset + raw.length !== file.size))
        throw Error("Source file changed or became unreadable while streaming.");
      let result;
      try {
        result = (await invoke("file_v2_put", {
          deviceId: targetId, transferId: activeTransfer, seq, data: bytesToBase64(raw),
        })).result;
      } catch (error) {
        const remote = await largeCheckpoint(file, sha256);
        if (remote.seq !== seq + 1 || remote.received !== offset + raw.length) throw error;
        result = remote;
      }
      if (!result || result.seq !== seq + 1 || result.received !== offset + raw.length)
        throw Error("Invalid V2 chunk acknowledgement.");
      offset = result.received;
      metrics(offset, file.size, offer.resumed ? "Resumed · " : "");
      state("Streaming " + file.name + " · " + offset + "/" + file.size + " bytes",
        offset * 100 / file.size);
    }
    assertActive();
    let result;
    try {
      result = (await invoke("file_v2_finish", {
        deviceId: targetId, transferId: activeTransfer,
      })).result;
    } catch (firstError) {
      // The verified save may have completed while its acknowledgment was lost.
      // Both V2 targets return an idempotent receipt for this exact transfer.
      try {
        result = (await invoke("file_v2_finish", {
          deviceId: targetId, transferId: activeTransfer,
        })).result;
      } catch { throw firstError; }
    }
    if (!result?.ok || result.bytes !== file.size)
      throw Error("Target did not confirm full SHA-256 verified V2 commit.");
    activeTransfer = null;
    activeProtocol = 1;
    controls();
    receipt("Sent", file.name, file.size, offer.resumed ? "V2 resumed & verified" : "V2 verified");
    return "Large file sent and SHA-256 verified on target. Saved to: " +
      (result.savedTo || "target's approved Downloads folder");
  }
  async function send(retry = false) {
    if (busy) return;
    const selectedDevice = selected();
    const input = $("lan-file-source");
    if (!selectedDevice) return;
    let jobs;
    if (retry) {
      if (!retryPlan?.length) return;
      jobs = retryPlan.slice();
      const active = window.__superagentLanListTransferTargets?.() || [selectedDevice];
      if (jobs.some(({ device }) => !active.some((d) => d.connected && d.id === device.id)) ||
          jobs.length > 8 * MAX_QUEUE_FILES) {
        state("Reconnect and re-approve every required device session before retry.");
        return;
      }
      if (!window.confirm("Retry " + jobs.length + " failed or not-yet-sent file/device transfer(s)? " +
        "The first item has an UNKNOWN outcome and may already be saved. " +
        "Inspect the target first to avoid an unwanted duplicate. " +
        "Every file requires new target-owner approval.")) return;
    } else {
      const files = Array.from(input?.files || []);
      if (!files.length) return;
      const all = $("lan-file-send-all")?.checked === true;
      const available = all ? window.__superagentLanListTransferTargets?.() : [selectedDevice];
      if (!Array.isArray(available) || !available.length || available.length > 8 ||
          available.some((d) => !d || !d.connected || typeof d.id !== "string" ||
            typeof d.label !== "string" || !["windows", "android"].includes(d.platform)) ||
          new Set(available.map((d) => d.id)).size !== available.length) {
        state("No valid target sessions, or more than 8 connected devices. Refresh LAN sessions.");
        return;
      }
      const targets = available.map((d) => ({ id: d.id, label: d.label, platform: d.platform }));
      if (files.length > MAX_QUEUE_FILES || files.some((file) =>
          !filenameAllowed(file.name) || !Number.isSafeInteger(file.size) ||
          file.size < 1 || file.size > V2_MAX ||
          (file.size > MAX && file.name.endsWith(".safolder")) ||
          targets.some((target) => file.size >
            (["windows", "android"].includes(target.platform) ? V2_MAX : MAX)))) {
        state("Select 1–32 safe ASCII files, max 256 MiB on updated Windows/Android V2 targets.");
        return;
      }
      jobs = targets.flatMap((device) => files.map((file) => ({ device, file })));
      const summary = targets.map((d) => d.label).join(", ");
      if (!window.confirm("Send " + files.length + " owner-selected file(s) to " +
        targets.length + " connected device(s): " + summary +
        "? Files are sent sequentially, and EACH target owner must approve EACH file.")) return;
    }
    retryPlan = null;
    const ticket = window.TrayFeedback?.begin({
      key: "lan:file:send", button: $("lan-file-send"),
      label: jobs.length > 1 ? "Sending verified file queue…" : "Sending file…",
    });
    if (window.TrayFeedback && !ticket) return;
    busy = true; cancelled = false; paused = false;
    sendingMany = new Set(jobs.map(({ device }) => device.id)).size > 1;
    targetId = jobs[0].device.id;
    activeTransfer = null; activeProtocol = 1;
    batch = { index: 0, total: jobs.length };
    controls();
    try {
      let message = "";
      for (let i = 0; i < jobs.length; i++) {
        const { file, device } = jobs[i];
        targetId = device.id;
        assertActive();
        batch.index = i;
        state("Queue " + (i + 1) + "/" + jobs.length + " · " + device.label +
          " · preparing " + file.name, 0);
        if (file.size > MAX) {
          message = await sendLargeFile(device, file);
        } else {
          const bytes = new Uint8Array(await file.arrayBuffer());
          assertActive();
          if (bytes.length !== file.size) throw Error("Local file changed during selection.");
          message = await sendBuffer(device, file.name, bytes);
        }
      }
      if (input) input.value = "";
      batch.index = jobs.length;
      state(jobs.length === 1 ? message :
        "Sent " + jobs.length + "/" + jobs.length +
        " selected file/device transfers; SHA-256 verified on every target.", 100);
      notifyTransfer("success", jobs.length + " verified file/device transfers.");
    } catch (error) {
      // A transport failure must not discard a disk-backed V2 resume checkpoint.
      // Only explicit owner Cancel revokes/purges the target's partial bytes.
      const keepV2Checkpoint = activeProtocol === 2 && !cancelled;
      if (!keepV2Checkpoint) await abortIfNeeded();
      retryPlan = jobs.slice(batch?.index ?? 0);
      state((keepV2Checkpoint ? "Send failed (V2 checkpoint retained): " : "Send failed: ") +  + String(error).slice(0, 200));
      const item = retryPlan[0];
      if (item) receipt("Send", item.device.label + ": " + item.file.name,
        item.file.size, "Not verified");
      notifyTransfer(/timed out|timeout|connection lost/i.test(String(error)) ? "warning" : "error",
        "Queue stopped. Inspect first uncertain target, then use explicit Retry remaining.");
    } finally {
      activeTransfer = null; activeProtocol = 1; sendingMany = false;
      busy = false; cancelled = false; paused = false;
      wake(); targetId = null; batch = null;
      ticket?.end(); controls();
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
    const ticket = window.TrayFeedback?.begin({
      key: "lan:file:folder", button: $("lan-folder-send"), label: "Sending folder…",
    });
    if (window.TrayFeedback && !ticket) return;
    busy = true; cancelled = false; paused = false; targetId = device.id; activeTransfer = null;
    controls();
    try {
      state("Checking safe relative paths and SHA-256 hashes...", 0);
      const archive = await packageFolder(files);
      const message = await sendBuffer(device, archive.name, archive.bytes,
        "Folder package sent (" + archive.count + " files), SHA-256 verified on target. " +
        "The receiving client must explicitly extract using its safe folder destination flow.");
      input.value = "";
      state(message, 100);
      notifyTransfer("success", "Folder archive verified on target; extraction requires approval.");
    } catch (error) {
      await abortIfNeeded();
      state("Folder send failed: " + String(error).slice(0, 200));
      receipt("Folder", "Selected folder", 0, "Not verified");
      notifyTransfer(/timed out|timeout|connection lost/i.test(String(error)) ? "warning" : "error",
        "Folder transfer was not confirmed. Inspect device status before retrying.");
    } finally {
      activeTransfer = null; busy = false; cancelled = false; paused = false;
      wake(); targetId = null;
      ticket?.end(); controls();
    }
  }
  async function receive() {
    if (busy) return;
    const device = selected();
    if (!device) return;
    if (!window.confirm("Request the file or folder that the " + device.platform +
      " owner explicitly selected for sharing? The owner must approve this transfer.")) return;
    const ticket = window.TrayFeedback?.begin({
      key: "lan:file:receive", button: $("lan-file-receive"), label: "Receiving file…",
    });
    if (window.TrayFeedback && !ticket) return;
    busy = true; cancelled = false; paused = false; targetId = device.id; activeTransfer = null;
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
      controls();
      const received = new Uint8Array(offer.size);
      for (let offset = 0, seq = 0; offset < offer.size; offset += CHUNK, seq++) {
        await waitIfPaused();
        let reply;
        try {
          reply = (await invoke("file_get", { deviceId: targetId,
            transferId: activeTransfer, seq })).result;
        } catch (error) {
          // Re-read only an unchanged, authenticated source, at most once.
          const remote = await checkpoint("download", offer.name, offer.size, offer.sha256);
          if (remote.seq !== seq && remote.seq !== seq + 1) throw error;
          reply = (await invoke("file_get", { deviceId: targetId,
            transferId: activeTransfer, seq })).result;
        }
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
      if (saved?.saved) {
        receipt("Received", offer.name, offer.size, "Verified");
        notifyTransfer("success", "Received file saved with SHA-256 verification.");
      }
    } catch (error) {
      await abortIfNeeded();
      state("Receive failed: " + String(error).slice(0, 200));
      notifyTransfer(/timed out|timeout|connection lost/i.test(String(error)) ? "warning" : "error",
        "File receive outcome was not verified. Inspect device status.");
    } finally {
      activeTransfer = null; busy = false; cancelled = false; paused = false;
      wake(); targetId = null;
      ticket?.end(); controls();
    }
  }
  function install() {
    $("lan-file-source")?.addEventListener("change", () => { retryPlan = null; controls(); });
    $("lan-folder-source")?.addEventListener("change", controls);
    $("lan-file-send")?.addEventListener("click", () => { void send(); });
    $("lan-file-retry")?.addEventListener("click", () => { void send(true); });
    $("lan-folder-send")?.addEventListener("click", () => { void sendFolder(); });
    $("lan-file-receive")?.addEventListener("click", () => { void receive(); });
    $("lan-file-pause")?.addEventListener("click", () => {
      if (!busy || !activeTransfer || cancelled) return;
      paused = !paused;
      if (!paused) wake();
      state(paused
        ? "Paused · resume before the 10-minute session idle expiry."
        : "Resuming transfer…");
      controls();
    });
    $("lan-file-cancel")?.addEventListener("click", () => {
      cancelled = true;
      paused = false;
      wake();
      state("Cancelling · an in-flight final save may already have completed. Verify target before retry.");
      controls();
      void abortIfNeeded();
    });
    window.__superagentLanFilesRefresh = controls;
    controls();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
