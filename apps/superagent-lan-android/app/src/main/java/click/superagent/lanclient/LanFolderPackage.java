package click.superagent.lanclient;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Offline SAFOLDER1 package reader for the existing 4 MiB owner-approved LAN
 * file transfer. Does not pair, discover, listen, or permit remote file paths.
 *
 * NOTE: The literal "SAFOLDER1" is 9 ASCII bytes, not 8. This matches the
 * TypeScript implementation exactly. Header: magic, uint32 BE JSON length,
 * strict UTF-8 JSON {version:1,files:[{path,size,sha256}]}, raw file bytes.
 *
 * Must only be called by UI/server after the normal physical file-transfer
 * approval. Extracts into private uniquely named MediaStore Downloads paths.
 */
public final class LanFolderPackage {
    public static final int MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
    public static final int MAX_MANIFEST_BYTES = 32 * 1024;
    public static final int MAX_FILES = 64;
    public static final int MAX_NESTED_LEVELS = 8;
    private static final byte[] MAGIC = "SAFOLDER1".getBytes(StandardCharsets.US_ASCII);
    private static final Pattern COMPONENT = Pattern.compile("[A-Za-z0-9_][A-Za-z0-9_ .()-]{0,95}");
    private static final Pattern DEVICE = Pattern.compile(
            "(?i)^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)");
    private static final Pattern SENSITIVE = Pattern.compile(
            "(?i)(?:^|[_ .(\\-])(?:secret|secrets|password|passwords|passwd|credential|credentials|private|token|tokens|apikey|api-key|accesskey|access-key|id_rsa|id_dsa|id_ecdsa|id_ed25519|keystore|wallet|recovery|seedphrase)(?:$|[_ .)\\-])");
    private static final Pattern SENSITIVE_SUFFIX = Pattern.compile(
            "(?i)\\.(?:pem|key|p12|pfx|jks|kdbx|asc)$");

    private LanFolderPackage() {}

    public static final class Entry {
        public final String path;
        public final int size;
        public final String sha256;
        public final int offset;
        private Entry(String path, int size, String sha256, int offset) {
            this.path = path;
            this.size = size;
            this.sha256 = sha256;
            this.offset = offset;
        }
    }

    public static final class Inspection {
        public final List<Entry> files;
        public final int packageBytes;
        private Inspection(List<Entry> files, int packageBytes) {
            this.files = Collections.unmodifiableList(new ArrayList<>(files));
            this.packageBytes = packageBytes;
        }
    }

    public static final class Extraction {
        public final String relativeDirectory;
        public final List<Uri> items;
        private Extraction(String relativeDirectory, List<Uri> items) {
            this.relativeDirectory = relativeDirectory;
            this.items = Collections.unmodifiableList(new ArrayList<>(items));
        }
    }

    private static IOException invalid(String reason) {
        return new IOException("Invalid SAFOLDER1 package: " + reason);
    }

    private static boolean exactKeys(JSONObject object, String... keys) {
        if (object.length() != keys.length) return false;
        for (String key : keys) if (!object.has(key)) return false;
        return true;
    }

    private static String validPath(Object candidate) throws IOException {
        if (!(candidate instanceof String)) throw invalid("path is not a string");
        String value = (String) candidate;
        if (value.isEmpty() || value.length() > 900 || value.startsWith("/")
                || value.indexOf('\\') >= 0 || value.indexOf(':') >= 0) {
            throw invalid("unsafe relative path");
        }
        String[] parts = value.split("/", -1);
        if (parts.length > MAX_NESTED_LEVELS + 1) throw invalid("nesting limit");
        for (String part : parts) {
            if (part.isEmpty() || part.startsWith(".") || part.endsWith(".")
                    || part.endsWith(" ") || !COMPONENT.matcher(part).matches()
                    || DEVICE.matcher(part).find() || SENSITIVE.matcher(part).find()
                    || SENSITIVE_SUFFIX.matcher(part).find()) {
                throw invalid("hidden, sensitive, or unsafe basename");
            }
        }
        return value;
    }

    private static int integer(Object value, int minimum, int maximum) throws IOException {
        if (!(value instanceof Number)) throw invalid("non-integer manifest field");
        Number n = (Number) value;
        long number = n.longValue();
        if (number < minimum || number > maximum || n.doubleValue() != (double) number) {
            throw invalid("out-of-range manifest integer");
        }
        return (int) number;
    }

    private static String sha256(byte[] input, int start, int length) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(input, start, length);
            byte[] bytes = digest.digest();
            final char[] alphabet = "0123456789abcdef".toCharArray();
            char[] hex = new char[64];
            for (int i = 0; i < bytes.length; i++) {
                hex[2 * i] = alphabet[(bytes[i] >>> 4) & 15];
                hex[2 * i + 1] = alphabet[bytes[i] & 15];
            }
            return new String(hex);
        } catch (NoSuchAlgorithmException e) {
            throw new IOException("SHA-256 is not available", e);
        }
    }

    /** Parses AND hashes the entire package before any extraction is attempted. */
    public static Inspection inspect(byte[] bytes) throws IOException {
        if (bytes == null || bytes.length > MAX_PACKAGE_BYTES ||
                bytes.length < MAGIC.length + 4) throw invalid("package size");
        for (int i = 0; i < MAGIC.length; i++) {
            if (bytes[i] != MAGIC[i]) throw invalid("magic");
        }
        int manifestLength = ByteBuffer.wrap(bytes, MAGIC.length, 4).getInt();
        int start = MAGIC.length + 4;
        if (manifestLength < 1 || manifestLength > MAX_MANIFEST_BYTES ||
                manifestLength > bytes.length - start) throw invalid("manifest length");
        String json;
        try {
            json = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes, start, manifestLength)).toString();
        } catch (CharacterCodingException e) {
            throw invalid("manifest UTF-8");
        }
        if (!json.isEmpty() && json.charAt(0) == '\ufeff') throw invalid("manifest BOM");
        JSONObject manifest;
        JSONArray array;
        try {
            manifest = new JSONObject(json);
            if (!exactKeys(manifest, "version", "files") ||
                    integer(manifest.get("version"), 1, 1) != 1) throw invalid("manifest version");
            array = manifest.getJSONArray("files");
        } catch (JSONException e) {
            throw invalid("manifest JSON");
        }
        if (array.length() < 1 || array.length() > MAX_FILES) throw invalid("file count");

        int offset = start + manifestLength;
        List<Entry> entries = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < array.length(); i++) {
            try {
                JSONObject item = array.getJSONObject(i);
                if (!exactKeys(item, "path", "size", "sha256")) throw invalid("entry keys");
                String relative = validPath(item.get("path"));
                String normalized = relative.toLowerCase(Locale.ROOT);
                if (!seen.add(normalized)) throw invalid("duplicate file path");
                int size = integer(item.get("size"), 0, MAX_PACKAGE_BYTES);
                Object digestValue = item.get("sha256");
                if (!(digestValue instanceof String)
                        || !((String) digestValue).matches("[a-f0-9]{64}")) {
                    throw invalid("entry SHA-256");
                }
                if (size > bytes.length - offset) throw invalid("truncated file bytes");
                String expected = (String) digestValue;
                if (!sha256(bytes, offset, size).equals(expected)) throw invalid("SHA-256 mismatch");
                entries.add(new Entry(relative, size, expected, offset));
                offset += size;
            } catch (JSONException e) {
                throw invalid("entry JSON");
            }
        }
        if (offset != bytes.length) throw invalid("trailing bytes");
        for (String filename : seen) {
            int slash = filename.indexOf('/');
            while (slash >= 0) {
                if (seen.contains(filename.substring(0, slash))) {
                    throw invalid("file/directory collision");
                }
                slash = filename.indexOf('/', slash + 1);
            }
        }
        return new Inspection(entries, bytes.length);
    }

    /**
     * Extract an ALREADY APPROVED package to app-selected MediaStore Downloads.
     * The destination is always Download/SuperAgent LAN/Folder-<random>/; no
     * caller-supplied or remote absolute paths and no existing-file overwrite.
     * Pending entries are deleted on any failure; only commit after all writes.
     */
    public static Extraction extract(Context context, byte[] bytes) throws IOException {
        Inspection inspection = inspect(bytes);
        if (context == null) throw new IOException("Android Context required.");
        String folder = "Folder-" + UUID.randomUUID().toString().replace("-", "");
        String relativeDirectory = Environment.DIRECTORY_DOWNLOADS +
                "/SuperAgent LAN/" + folder + "/";
        ContentResolver resolver = context.getContentResolver();
        List<Uri> created = new ArrayList<>();
        try {
            for (Entry entry : inspection.files) {
                int divider = entry.path.lastIndexOf('/');
                String subpath = divider >= 0 ? entry.path.substring(0, divider + 1) : "";
                String filename = divider >= 0 ? entry.path.substring(divider + 1) : entry.path;
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                values.put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                        relativeDirectory + subpath);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IOException("MediaStore refused new output.");
                created.add(uri);
                try (OutputStream stream = resolver.openOutputStream(uri, "w")) {
                    if (stream == null) throw new IOException("Cannot open MediaStore output.");
                    stream.write(bytes, entry.offset, entry.size);
                    stream.flush();
                }
            }
            // Make files visible only after the complete package is written.
            for (Uri uri : created) {
                ContentValues ready = new ContentValues();
                ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
                if (resolver.update(uri, ready, null, null) != 1) {
                    throw new IOException("Unable to publish all folder files.");
                }
            }
            return new Extraction(relativeDirectory, created);
        } catch (Exception error) {
            for (Uri uri : created) {
                try { resolver.delete(uri, null, null); } catch (Exception ignored) {}
            }
            if (error instanceof IOException) throw (IOException) error;
            throw new IOException("Safe folder extraction failed; created items removed.", error);
        }
    }
}
