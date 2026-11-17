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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/** Android V2 target: private, bounded, resumable upload-to-Downloads.
 * All methods are called only by the authenticated, approved LAN server.
 * An offer (including restart recovery) MUST be approved on the phone first.
 */
public final class LanFileExchangeV2 {
    static final long MAX_BYTES = 256L * 1024 * 1024;
    static final int CHUNK_BYTES = 16 * 1024;
    private static final long EXPIRE_MS = 600_000L;
    private static final long PERSIST_MS = 24L * 60 * 60 * 1000;
    private final Context context;
    private final File stage;
    private final AtomicLong generation = new AtomicLong();
    private volatile Pending active;
    private JSONObject receipt;
    private long receiptAt;

    private static final class Pending {
        String id, name, sha256;
        long size, created, received, lastUsed;
        int seq;
    }

    public LanFileExchangeV2(Context context) {
        this.context = context.getApplicationContext();
        this.stage = new File(this.context.getFilesDir(), "lan-v2-partials");
    }
    private static String safeName(String name) {
        return LanFileExchange.name(name);
    }
    private static void validate(String name, long size, String digest) {
        safeName(name);
        if (name.endsWith(".safolder") || size < 1 || size > MAX_BYTES ||
                digest == null || !digest.matches("[a-f0-9]{64}"))
            throw new SecurityException("Invalid V2 file metadata.");
    }
    private static String digest(File file) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int bytes;
            while ((bytes = input.read(buffer)) != -1) hash.update(buffer, 0, bytes);
        }
        StringBuilder result = new StringBuilder(64);
        for (byte b : hash.digest()) result.append(String.format(Locale.US, "%02x", b & 0xff));
        return result.toString();
    }
    private File part(String id) { return new File(stage, id + ".part"); }
    private File meta(String id) { return new File(stage, id + ".json"); }
    private static boolean uuid(String value) {
        return value != null && value.matches("[0-9a-f-]{36}");
    }
    private void ensureStage() {
        if (!stage.isDirectory() && !stage.mkdirs()) throw new SecurityException("V2 private staging unavailable.");
        if (!stage.isDirectory() || stage.isFile()) throw new SecurityException("Unsafe V2 staging.");
    }
    private static String readMetadata(File file) throws Exception {
        if (!file.isFile() || file.length() > 1024) throw new SecurityException("Invalid checkpoint.");
        try (FileInputStream in = new FileInputStream(file);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] b = new byte[512];
            int count;
            while ((count = in.read(b)) > 0) {
                if (out.size() + count > 1024) throw new SecurityException("Checkpoint oversized.");
                out.write(b, 0, count);
            }
            return out.toString("UTF-8");
        }
    }
    private Pending load(String id) {
        if (!uuid(id)) return null;
        try {
            JSONObject obj = new JSONObject(readMetadata(meta(id)));
            Pending value = new Pending();
            value.id = obj.getString("id");
            value.name = obj.getString("name");
            value.sha256 = obj.getString("sha256");
            value.size = obj.getLong("size");
            value.created = obj.getLong("created");
            if (!id.equals(value.id) || obj.getInt("v") != 2 ||
                    value.created > System.currentTimeMillis() + 60_000 ||
                    System.currentTimeMillis() - value.created > PERSIST_MS)
                return null;
            validate(value.name, value.size, value.sha256);
            File data = part(id);
            if (!data.isFile() || data.length() > value.size ||
                    (data.length() % CHUNK_BYTES != 0 && data.length() != value.size))
                return null;
            value.received = data.length();
            value.seq = (int) ((value.received + CHUNK_BYTES - 1) / CHUNK_BYTES);
            value.lastUsed = SystemClock.elapsedRealtime();
            return value;
        } catch (Exception denied) { return null; }
    }
    public synchronized JSONObject offer(String name, long size, String sha) throws Exception {
        validate(name, size, sha);
        if (active != null && SystemClock.elapsedRealtime() - active.lastUsed < EXPIRE_MS)
            throw new SecurityException("Another V2 transfer active.");
        active = null;
        ensureStage();
        File[] entries = stage.listFiles((dir, filename) -> filename.endsWith(".json"));
        if (entries == null || entries.length > 512)
            throw new SecurityException("V2 transfer staging quota reached.");
        Pending matched = null;
        for (File file : entries) {
            String id = file.getName().replaceFirst("\\.json$", "");
            Pending previous = load(id);
            if (previous != null && previous.name.equals(name) &&
                    previous.size == size && previous.sha256.equals(sha)) {
                matched = previous; break;
            }
        }
        if (matched == null) {
            matched = new Pending();
            matched.id = UUID.randomUUID().toString();
            matched.name = name;
            matched.size = size;
            matched.sha256 = sha;
            matched.created = System.currentTimeMillis();
            matched.lastUsed = SystemClock.elapsedRealtime();
            if (!part(matched.id).createNewFile()) throw new SecurityException("V2 staging collision.");
            JSONObject metadata = new JSONObject().put("v", 2).put("id", matched.id)
                    .put("name", name).put("size", size).put("sha256", sha)
                    .put("created", matched.created);
            try (FileOutputStream output = new FileOutputStream(meta(matched.id), false)) {
                output.write(metadata.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                output.getFD().sync();
            } catch (Exception fail) {
                part(matched.id).delete();
                meta(matched.id).delete();
                throw fail;
            }
        }
        active = matched;
        receipt = null;
        return new JSONObject().put("ok", true).put("version", 2)
                .put("transferId", matched.id).put("direction", "upload")
                .put("name", name).put("size", size).put("sha256", sha)
                .put("chunkBytes", CHUNK_BYTES).put("seq", matched.seq)
                .put("received", matched.received).put("resumed", matched.received > 0);
    }
    private Pending check(String id) {
        Pending p = active;
        if (p == null || !p.id.equals(id)) throw new SecurityException("Unknown V2 transfer.");
        if (SystemClock.elapsedRealtime() - p.lastUsed > EXPIRE_MS) {
            active = null;
            throw new SecurityException("V2 transfer idle expiry; request approval again.");
        }
        return p;
    }
    public synchronized JSONObject status(String id) throws Exception {
        if (receipt != null && receipt.optString("transferId").equals(id) &&
                SystemClock.elapsedRealtime() - receiptAt < EXPIRE_MS)
            return new JSONObject(receipt.toString()).put("completed", true);
        Pending p = check(id);
        return new JSONObject().put("ok", true).put("version", 2)
                .put("transferId", p.id).put("direction", "upload")
                .put("name", p.name).put("size", p.size).put("sha256", p.sha256)
                .put("seq", p.seq).put("received", p.received).put("completed", false);
    }
    public synchronized JSONObject put(String id, int seq, String encoded) throws Exception {
        Pending p = check(id);
        if (seq != p.seq || encoded == null || encoded.isEmpty() ||
                encoded.length() > 21848 ||
                !encoded.matches("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?"))
            throw new SecurityException("Out-of-order or malformed V2 chunk.");
        byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
        if (bytes.length < 1 || bytes.length > CHUNK_BYTES ||
                p.received + bytes.length > p.size ||
                (bytes.length != CHUNK_BYTES && p.received + bytes.length != p.size) ||
                !Base64.encodeToString(bytes, Base64.NO_WRAP).equals(encoded))
            throw new SecurityException("Invalid V2 chunk length or padding.");
        File file = part(id);
        if (!file.isFile() || file.length() != p.received)
            throw new SecurityException("V2 staged bytes changed.");
        try (RandomAccessFile output = new RandomAccessFile(file, "rw")) {
            output.seek(p.received);
            output.write(bytes);
            output.getFD().sync();
        }
        p.received += bytes.length;
        p.seq++;
        p.lastUsed = SystemClock.elapsedRealtime();
        return new JSONObject().put("ok", true).put("seq", p.seq).put("received", p.received);
    }
    public synchronized JSONObject finish(String id) throws Exception {
        if (receipt != null && receipt.optString("transferId").equals(id) &&
                SystemClock.elapsedRealtime() - receiptAt < EXPIRE_MS) return receipt;
        long expected = generation.get();
        Pending p = check(id);
        File file = part(id);
        if (p.received != p.size || !file.isFile() || file.length() != p.size ||
                !digest(file).equals(p.sha256))
            throw new SecurityException("Incomplete or SHA-256 invalid V2 file.");
        if (generation.get() != expected) throw new SecurityException("V2 transfer revoked.");
        String finalName = UUID.randomUUID().toString().substring(0, 8) + "-" + p.name;
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, finalName);
        values.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream");
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/SuperAgent LAN");
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IllegalStateException("Cannot stage Android Downloads file.");
        try {
            try (FileInputStream source = new FileInputStream(file);
                 OutputStream destination = context.getContentResolver().openOutputStream(uri, "w")) {
                if (destination == null) throw new IllegalStateException("MediaStore destination unavailable.");
                byte[] buffer = new byte[64 * 1024];
                int length;
                while ((length = source.read(buffer)) != -1) {
                    if (generation.get() != expected)
                        throw new SecurityException("V2 revoked while publishing.");
                    destination.write(buffer, 0, length);
                }
            }
            if (generation.get() != expected)
                throw new SecurityException("V2 revoked before final publish.");
            ContentValues visible = new ContentValues();
            visible.put(MediaStore.Downloads.IS_PENDING, 0);
            context.getContentResolver().update(uri, visible, null, null);
            if (generation.get() != expected)
                throw new SecurityException("V2 revoked during final publish.");
        } catch (Exception fail) {
            context.getContentResolver().delete(uri, null, null);
            throw fail;
        }
        if (generation.get() != expected) {
            context.getContentResolver().delete(uri, null, null);
            throw new SecurityException("V2 revoked during commit.");
        }
        active = null;
        if (!part(id).delete() || !meta(id).delete())
            throw new IllegalStateException("V2 completed but staging cleanup failed.");
        receipt = new JSONObject().put("ok", true).put("transferId", id)
                .put("bytes", p.size).put("name", finalName)
                .put("savedTo", "Downloads/SuperAgent LAN");
        receiptAt = SystemClock.elapsedRealtime();
        return receipt;
    }
    public JSONObject abort(String id) {
        Pending expected = active;
        if (expected != null && expected.id.equals(id)) {
            generation.incrementAndGet();
            synchronized (this) {
                if (active == expected) active = null;
                part(id).delete();
                meta(id).delete();
            }
        }
        return new JSONObject().put("ok", true);
    }
    public void suspend() {
        generation.incrementAndGet();
        synchronized (this) { active = null; receipt = null; }
    }
    public void purge() {
        generation.incrementAndGet();
        synchronized (this) {
            active = null;
            receipt = null;
            if (!stage.isDirectory()) return;
            File[] files = stage.listFiles();
            if (files == null) return;
            for (File f : files) {
                String name = f.getName();
                if (name.matches("[0-9a-f-]{36}\\.(?:json|part)")) f.delete();
            }
        }
    }
}
