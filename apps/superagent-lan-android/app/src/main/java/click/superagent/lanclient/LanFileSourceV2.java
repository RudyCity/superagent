package click.superagent.lanclient;

import android.content.Context;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Base64;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/** Explicit Android SAF selection, private disk-backed V2 outbound source.
 * The Android owner chooses the URI; no remote caller can supply a URI/path.
 * No whole-file RAM allocation, and selections expire on owner clear/revoke.
 */
public final class LanFileSourceV2 {
    private static final int CHUNK = 16 * 1024;
    private static final long MAX = 256L * 1024 * 1024;
    private static final long EXPIRE_MS = 600_000;
    private final Context context;
    private final File stage;
    private final AtomicLong generation = new AtomicLong();
    private Selection selection;
    private volatile Active active;
    private JSONObject receipt;
    private long receiptAt;
    private long revision;
    private static final class Selection {
        File file;
        String name, sha;
        long size, revision;
    }
    private static final class Active {
        Selection selected;
        String id;
        int seq;
        long lastUsed, epoch;
    }

    public LanFileSourceV2(Context context) {
        this.context = context.getApplicationContext();
        stage = new File(this.context.getFilesDir(), "lan-v2-selected-source");
        if (!stage.isDirectory() && !stage.mkdirs())
            throw new SecurityException("Cannot create private V2 source stage.");
        // No inherited grants or stale source authorization survives restart.
        File[] old = stage.listFiles();
        if (old != null) for (File f : old) {
            if (f.isFile() && f.getName().matches("[0-9a-f-]{36}\\.part")) f.delete();
        }
    }
    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] chunk = new byte[64 * 1024];
            int n;
            while ((n = input.read(chunk)) != -1) digest.update(chunk, 0, n);
        }
        StringBuilder output = new StringBuilder(64);
        for (byte b : digest.digest())
            output.append(String.format(Locale.US, "%02x", b & 0xff));
        return output.toString();
    }
    /** Invoked from a background thread after an Android ACTION_OPEN_DOCUMENT result. */
    public synchronized JSONObject select(Uri ownerChosen, String name) throws Exception {
        String checked = LanFileExchange.name(name);
        if (checked.endsWith(".safolder")) throw new SecurityException("Use the bounded folder archive protocol.");
        clear();
        if (ownerChosen == null || !("content".equals(ownerChosen.getScheme())))
            throw new SecurityException("Use Android's document picker to choose a source.");
        File file = new File(stage, UUID.randomUUID() + ".part");
        if (!file.createNewFile()) throw new SecurityException("Cannot create private source.");
        long length = 0;
        try (InputStream input = context.getContentResolver().openInputStream(ownerChosen);
             FileOutputStream out = new FileOutputStream(file, false)) {
            if (input == null) throw new SecurityException("Document is not readable.");
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = input.read(buffer)) != -1) {
                if (n == 0) continue;
                length += n;
                if (length > MAX) throw new SecurityException("Document exceeds 256 MiB.");
                out.write(buffer, 0, n);
            }
            out.getFD().sync();
        } catch (Exception error) {
            file.delete();
            throw error;
        }
        if (length <= 4L * 1024 * 1024) {
            file.delete();
            throw new SecurityException("Use Select File for documents of 4 MiB or less.");
        }
        Selection next = new Selection();
        next.file = file;
        next.name = checked;
        next.size = length;
        next.sha = sha256(file);
        next.revision = ++revision;
        selection = next;
        return new JSONObject().put("name", checked).put("size", length)
                .put("sha256", next.sha);
    }
    public synchronized JSONObject shared() throws Exception {
        Selection s = selection;
        return s == null ? null : new JSONObject().put("name", s.name)
                .put("size", s.size).put("sha256", s.sha)
                .put("revision", s.revision);
    }
    public synchronized JSONObject offer(long approvedRevision) throws Exception {
        Selection s = selection;
        if (s == null || s.revision != approvedRevision || !s.file.isFile() ||
                s.file.length() != s.size)
            throw new SecurityException("Owner-selected large document changed.");
        if (active != null && SystemClock.elapsedRealtime() - active.lastUsed < EXPIRE_MS)
            throw new SecurityException("Another source transfer is active.");
        Active next = new Active();
        next.selected = s;
        next.id = UUID.randomUUID().toString();
        next.lastUsed = SystemClock.elapsedRealtime();
        next.epoch = generation.get();
        active = next;
        receipt = null;
        return new JSONObject().put("ok", true).put("version", 2)
                .put("transferId", next.id).put("direction", "download")
                .put("name", s.name).put("size", s.size).put("sha256", s.sha)
                .put("chunkBytes", CHUNK).put("seq", 0).put("received", 0)
                .put("resumed", false);
    }
    private Active check(String id) {
        Active a = active;
        if (a == null || !a.id.equals(id) || a.epoch != generation.get())
            throw new SecurityException("Unknown V2 source.");
        if (SystemClock.elapsedRealtime() - a.lastUsed > EXPIRE_MS) {
            active = null;
            throw new SecurityException("V2 source transfer expired.");
        }
        return a;
    }
    public synchronized JSONObject status(String id) throws Exception {
        if (receipt != null && receipt.optString("transferId").equals(id) &&
                SystemClock.elapsedRealtime() - receiptAt < EXPIRE_MS)
            return new JSONObject(receipt.toString()).put("completed", true);
        Active a = check(id);
        Selection s = a.selected;
        return new JSONObject().put("ok", true).put("version", 2)
                .put("direction", "download").put("transferId", a.id)
                .put("name", s.name).put("size", s.size).put("sha256", s.sha)
                .put("seq", a.seq).put("received", Math.min(s.size, (long)a.seq * CHUNK))
                .put("completed", false);
    }
    public synchronized JSONObject get(String id, int seq) throws Exception {
        Active a = check(id);
        if (seq != a.seq && seq != a.seq - 1)
            throw new SecurityException("Out-of-order source chunk.");
        Selection s = a.selected;
        long offset = (long)seq * CHUNK;
        if (offset < 0 || offset >= s.size || !s.file.isFile() || s.file.length() != s.size)
            throw new SecurityException("Owner-selected source changed or ended.");
        int length = (int)Math.min(CHUNK, s.size - offset);
        byte[] chunk = new byte[length];
        try (RandomAccessFile reader = new RandomAccessFile(s.file, "r")) {
            reader.seek(offset);
            reader.readFully(chunk);
        }
        if (a.epoch != generation.get() || active != a)
            throw new SecurityException("Source revoked during read.");
        if (seq == a.seq) a.seq++;
        a.lastUsed = SystemClock.elapsedRealtime();
        return new JSONObject().put("ok", true).put("seq", seq)
                .put("received", offset + length)
                .put("data", Base64.encodeToString(chunk, Base64.NO_WRAP));
    }
    public synchronized JSONObject finish(String id) throws Exception {
        if (receipt != null && receipt.optString("transferId").equals(id) &&
                SystemClock.elapsedRealtime() - receiptAt < EXPIRE_MS) return receipt;
        Active a = check(id);
        Selection s = a.selected;
        if ((long)a.seq * CHUNK < s.size || !s.file.isFile() ||
                s.file.length() != s.size || !sha256(s.file).equals(s.sha))
            throw new SecurityException("V2 source incomplete or hash mismatch.");
        if (a.epoch != generation.get() || active != a)
            throw new SecurityException("V2 source revoked.");
        active = null;
        receipt = new JSONObject().put("ok", true).put("transferId", id)
                .put("name", s.name).put("bytes", s.size);
        receiptAt = SystemClock.elapsedRealtime();
        return receipt;
    }
    public JSONObject abort(String id) throws Exception {
        Active a = active;
        if (a != null && a.id.equals(id)) {
            generation.incrementAndGet();
            synchronized (this) { if (active == a) active = null; }
        }
        return new JSONObject().put("ok", true);
    }
    public synchronized long selectionRevision() { return selection == null ? -1 : selection.revision; }
    public synchronized boolean isActive() {
        Active a = active;
        return a != null && SystemClock.elapsedRealtime() - a.lastUsed < EXPIRE_MS;
    }
    public synchronized void suspend() { generation.incrementAndGet(); active = null; receipt = null; }
    public synchronized void clear() {
        suspend();
        revision++;
        if (selection != null) selection.file.delete();
        selection = null;
    }
}
