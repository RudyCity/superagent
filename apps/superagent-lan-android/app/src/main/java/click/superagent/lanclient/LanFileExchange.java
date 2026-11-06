package click.superagent.lanclient;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Base64;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/**
 * RAM-only, per-transfer-consented Android file exchange.
 * Source bytes are picked by the Android owner in ACTION_OPEN_DOCUMENT.
 * Incoming files appear in Downloads/SuperAgent LAN only after SHA-256 pass.
 */
public final class LanFileExchange {
    public static final int MAX_BYTES = 4 * 1024 * 1024;
    public static final int CHUNK_BYTES = 4096;
    private static final int EXPIRE_MS = 600_000;
    private final Context context;
    // Revocation must take effect even when a synchronized MediaStore write
    // is in progress. A generation increment is visible without waiting for
    // the object's monitor, and committed output is deleted if it changed.
    private final AtomicLong revocationGeneration = new AtomicLong();

    private static final class Pending {
        String id, name, direction, checksum;
        int size, sequence, received;
        long lastUsed;
        ByteArrayOutputStream buffer;
        byte[] source;
    }
    private Pending active;
    private byte[] selected;
    private String selectedName;

    public LanFileExchange(Context context) { this.context = context.getApplicationContext(); }
    public void clear() {
        revocationGeneration.incrementAndGet();
        synchronized (this) {
            active = null;
            selected = null;
            selectedName = null;
        }
    }
    public synchronized void select(String name, byte[] bytes) {
        String checked = name(name);
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_BYTES)
            throw new SecurityException("File must be 1 byte to 4 MiB.");
        selectedName = checked;
        selected = Arrays.copyOf(bytes, bytes.length);
    }
    public synchronized String selectedLabel() {
        return selected == null ? "No file selected" : selectedName + " (" + selected.length + " bytes)";
    }
    public synchronized String offeredName(String direction, String filename, int size) {
        if ("download".equals(direction)) {
            if (selected == null) throw new SecurityException("Select a file on the Android phone first.");
            return selectedName;
        }
        if (!"upload".equals(direction) || size <= 0 || size > MAX_BYTES)
            throw new SecurityException("File transfer unavailable.");
        return name(filename);
    }
    public static String name(String name) {
        if (name == null || name.isEmpty() || name.length() > 96
                || name.equals(".") || name.equals("..")
                || name.startsWith(".") || name.endsWith(" ") || name.endsWith(".")
                || !name.matches("[A-Za-z0-9_][A-Za-z0-9_ .()-]{0,95}")) {
            throw new SecurityException("Filename must be a safe 1-96 character basename.");
        }
        return name;
    }
    private static String digest(byte[] bytes) throws Exception {
        byte[] sha = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder out = new StringBuilder(64);
        for (byte b : sha) out.append(String.format(Locale.US, "%02x", b & 0xff));
        return out.toString();
    }
    public synchronized JSONObject offer(String direction, String filename, int size, String hash) throws Exception {
        if (active != null && SystemClock.elapsedRealtime() - active.lastUsed < EXPIRE_MS)
            throw new SecurityException("Another file transfer is active.");
        active = null;
        Pending next = new Pending();
        next.id = UUID.randomUUID().toString();
        next.direction = direction;
        if ("download".equals(direction)) {
            if (selected == null) throw new SecurityException("Owner has not selected file to share.");
            next.name = selectedName;
            next.source = selected;
            next.size = selected.length;
            next.checksum = digest(selected);
        } else {
            next.name = name(filename);
            if (size < 1 || size > MAX_BYTES || hash == null || !hash.matches("[a-f0-9]{64}"))
                throw new SecurityException("Invalid declared file metadata.");
            next.size = size;
            next.checksum = hash;
            next.buffer = new ByteArrayOutputStream(Math.min(size, 128 * 1024));
        }
        next.lastUsed = SystemClock.elapsedRealtime();
        active = next;
        return new JSONObject().put("ok", true).put("transferId", next.id)
                .put("name", next.name).put("direction", next.direction)
                .put("size", next.size).put("sha256", next.checksum).put("chunkBytes", CHUNK_BYTES);
    }
    private Pending check(String id) {
        if (active == null || id == null || !id.equals(active.id))
            throw new SecurityException("Unknown transfer.");
        if (SystemClock.elapsedRealtime() - active.lastUsed >= EXPIRE_MS) {
            active = null;
            throw new SecurityException("Transfer expired.");
        }
        return active;
    }
    public synchronized JSONObject put(String id, int seq, String encoded) throws Exception {
        Pending transfer = check(id);
        if (!"upload".equals(transfer.direction) || seq != transfer.sequence || encoded == null
                || encoded.length() > 5464 || encoded.isEmpty()
                || !encoded.matches("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?"))
            throw new SecurityException("Out-of-order or invalid upload chunk.");
        byte[] part = Base64.decode(encoded, Base64.NO_WRAP);
        if (part.length < 1 || part.length > CHUNK_BYTES || transfer.received + part.length > transfer.size
                || !Base64.encodeToString(part, Base64.NO_WRAP).equals(encoded))
            throw new SecurityException("Invalid chunk length.");
        transfer.buffer.write(part);
        transfer.received += part.length;
        transfer.sequence++;
        transfer.lastUsed = SystemClock.elapsedRealtime();
        return new JSONObject().put("ok", true).put("seq", transfer.sequence)
                .put("received", transfer.received);
    }
    public synchronized JSONObject get(String id, int seq) throws Exception {
        Pending transfer = check(id);
        if (!"download".equals(transfer.direction) || transfer.source == null || seq != transfer.sequence)
            throw new SecurityException("Out-of-order download chunk.");
        int offset = seq * CHUNK_BYTES;
        if (offset < 0 || offset >= transfer.size) throw new SecurityException("No further bytes.");
        int length = Math.min(CHUNK_BYTES, transfer.size - offset);
        byte[] chunk = Arrays.copyOfRange(transfer.source, offset, offset + length);
        transfer.sequence++;
        transfer.lastUsed = SystemClock.elapsedRealtime();
        return new JSONObject().put("ok", true).put("seq", seq)
                .put("received", offset + length)
                .put("data", Base64.encodeToString(chunk, Base64.NO_WRAP));
    }
    public synchronized JSONObject finish(String id) throws Exception {
        final long expectedGeneration = revocationGeneration.get();
        Pending transfer = check(id);
        if ("download".equals(transfer.direction)) {
            if ((long)transfer.sequence * CHUNK_BYTES < transfer.size)
                throw new SecurityException("Incomplete download.");
            active = null;
            return new JSONObject().put("ok", true).put("name", transfer.name).put("bytes", transfer.size);
        }
        if (transfer.received != transfer.size) throw new SecurityException("Incomplete upload.");
        byte[] bytes = transfer.buffer.toByteArray();
        if (!MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(bytes),
                hexToBytes(transfer.checksum))) throw new SecurityException("File SHA-256 mismatch.");
        if (revocationGeneration.get() != expectedGeneration)
            throw new SecurityException("Transfer revoked before commit.");
        if (transfer.name.endsWith(".safolder")) {
            // Validate the manifest and ALL per-file hashes before publishing.
            LanFolderPackage.Extraction folder = LanFolderPackage.extract(context, bytes);
            if (revocationGeneration.get() != expectedGeneration) {
                for (Uri item : folder.items) {
                    try { context.getContentResolver().delete(item, null, null); }
                    catch (Exception ignored) {}
                }
                throw new SecurityException("Folder transfer revoked during import.");
            }
            active = null;
            return new JSONObject().put("ok", true).put("name", transfer.name)
                .put("bytes", bytes.length).put("files", folder.items.size())
                .put("savedTo", folder.relativeDirectory);
        }
        ContentValues values = new ContentValues();
        String newName = UUID.randomUUID().toString().substring(0, 8) + "-" + transfer.name;
        values.put(MediaStore.Downloads.DISPLAY_NAME, newName);
        values.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream");
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/SuperAgent LAN");
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IllegalStateException("Cannot create Android Downloads file.");
        try {
            try (OutputStream output = context.getContentResolver().openOutputStream(uri, "w")) {
                if (output == null) throw new IllegalStateException("Downloads output not writable.");
                output.write(bytes);
            }
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.Downloads.IS_PENDING, 0);
            context.getContentResolver().update(uri, ready, null, null);
            if (revocationGeneration.get() != expectedGeneration) {
                context.getContentResolver().delete(uri, null, null);
                throw new SecurityException("File transfer revoked during save.");
            }
        } catch (Exception failure) {
            context.getContentResolver().delete(uri, null, null);
            throw failure;
        }
        active = null;
        return new JSONObject().put("ok", true).put("name", newName)
                .put("bytes", bytes.length).put("savedTo", "Downloads/SuperAgent LAN");
    }
    private static byte[] hexToBytes(String hex) {
        byte[] output = new byte[hex.length()/2];
        for (int i = 0; i < output.length; i++) {
            output[i] = (byte) Integer.parseInt(hex.substring(i*2,i*2+2),16);
        }
        return output;
    }
    public synchronized JSONObject abort(String id) throws Exception {
        if (active != null && active.id.equals(id)) active = null;
        return new JSONObject().put("ok", true);
    }
}
