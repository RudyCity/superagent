package click.superagent.lanclient;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Owner-selected Android folder exporter using an OS-approved Storage Access
 * Framework tree URI. No general filesystem, root, ADB, or disk permissions.
 * SAFOLDER1 archives are bounded, validated by LanFolderPackage.inspect and
 * staged only in RAM. The owner must separately approve each LAN file offer.
 */
public final class LanFolderExport {
    private static final byte[] MAGIC = "SAFOLDER1".getBytes(StandardCharsets.US_ASCII);
    private static final int MAX_BYTES = 4 * 1024 * 1024;
    private static final int MAX_FILES = 64;
    private static final int MAX_LEVELS = 8;
    private static final int MAX_MANIFEST = 32 * 1024;

    public static final class Packed {
        public final String name;
        public final byte[] bytes;
        public final int fileCount;
        private Packed(String name, byte[] bytes, int count) {
            this.name = name;
            this.bytes = bytes;
            this.fileCount = count;
        }
    }

    private static final class Document {
        String id;
        String name;
        String mime;
        long size;
        int flags;
        Document(String id, String name, String mime, long size, int flags) {
            this.id = id; this.name = name; this.mime = mime;
            this.size = size; this.flags = flags;
        }
    }

    private static final class PackedFile {
        final String relative;
        final byte[] bytes;
        final String sha256;
        PackedFile(String relative, byte[] bytes, String sha256) {
            this.relative = relative;
            this.bytes = bytes;
            this.sha256 = sha256;
        }
    }
    private LanFolderExport() {}

    private static String safeName(String raw) throws Exception {
        if (raw == null || raw.isEmpty() || raw.length() > 96 ||
                raw.startsWith(".") || raw.endsWith(".") || raw.endsWith(" ") ||
                !raw.matches("[A-Za-z0-9_][A-Za-z0-9_ .()-]{0,95}"))
            throw new SecurityException("Unsafe/hidden folder entry.");
        String lower = raw.toLowerCase(Locale.ROOT);
        String basename = lower.split("\\.", 2)[0];
        if (basename.equals("con") || basename.equals("prn") ||
                basename.equals("aux") || basename.equals("nul") ||
                basename.matches("(com|lpt)[1-9]"))
            throw new SecurityException("Unsupported reserved Windows name.");
        if (lower.matches(".*(?:^|[_ .(-])(?:secret|secrets|password|passwords|passwd|credential|credentials|private|token|tokens|apikey|accesskey|id_rsa|id_dsa|id_ecdsa|id_ed25519|keystore|wallet|recovery|seedphrase)(?:$|[_ .)-]).*") ||
                lower.matches(".*\\.(pem|key|p12|pfx|jks|kdbx|asc)$"))
            throw new SecurityException("Sensitive file/folder name is not transferable.");
        return raw;
    }
    private static String fingerprint(byte[] bytes) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder result = new StringBuilder(64);
        for (byte b : hash) result.append(String.format(Locale.US, "%02x", b & 0xff));
        return result.toString();
    }
    private static Document readMeta(Context c, Uri docUri) throws Exception {
        String[] projection = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_FLAGS,
        };
        try (Cursor cur = c.getContentResolver().query(docUri, projection, null, null, null)) {
            if (cur == null || !cur.moveToFirst()) throw new SecurityException("Selected folder metadata unavailable.");
            return new Document(
                cur.getString(0), cur.getString(1), cur.getString(2),
                cur.isNull(3) ? -1 : cur.getLong(3),
                cur.isNull(4) ? 0 : cur.getInt(4)
            );
        }
    }
    private static List<Document> children(Context c, Uri treeUri, String parentId) throws Exception {
        Uri listing = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId);
        String[] projection = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_FLAGS,
        };
        List<Document> docs = new ArrayList<>();
        try (Cursor cur = c.getContentResolver().query(listing, projection, null, null, null)) {
            if (cur == null) throw new SecurityException("Folder content unavailable from SAF provider.");
            while (cur.moveToNext()) {
                if (docs.size() >= MAX_FILES + 1) throw new SecurityException("Too many folder entries.");
                docs.add(new Document(cur.getString(0), cur.getString(1), cur.getString(2),
                        cur.isNull(3) ? -1 : cur.getLong(3), cur.isNull(4) ? 0 : cur.getInt(4)));
            }
        }
        docs.sort(Comparator.comparing(d -> d.name, String.CASE_INSENSITIVE_ORDER));
        return docs;
    }
    private static void walk(Context c, Uri treeUri, String parentId, String prefix,
                             int depth, List<PackedFile> out, Set<String> seen) throws Exception {
        List<Document> docs = children(c, treeUri, parentId);
        if (docs.isEmpty()) throw new SecurityException("Empty directories cannot be transferred.");
        for (Document doc : docs) {
            String component = safeName(doc.name);
            String relative = prefix.isEmpty() ? component : prefix + "/" + component;
            if (relative.length() > 900 || relative.split("/").length > MAX_LEVELS + 1)
                throw new SecurityException("Folder nesting is too deep.");
            boolean folder = DocumentsContract.Document.MIME_TYPE_DIR.equals(doc.mime);
            if (folder) {
                if (depth >= MAX_LEVELS) throw new SecurityException("Nested folder depth limit exceeded.");
                walk(c, treeUri, doc.id, relative, depth + 1, out, seen);
                continue;
            }
            if ((doc.flags & DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT) != 0)
                throw new SecurityException("Virtual documents cannot be transferred.");
            if (out.size() >= MAX_FILES) throw new SecurityException("Folder exceeds 64 files.");
            String canonical = relative.toLowerCase(Locale.ROOT);
            if (!seen.add(canonical)) throw new SecurityException("Duplicate case-insensitive file path.");
            if (doc.size > MAX_BYTES) throw new SecurityException("File exceeds 4 MiB.");
            Uri uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, doc.id);
            byte[] bytes;
            try (InputStream in = c.getContentResolver().openInputStream(uri);
                 ByteArrayOutputStream received = new ByteArrayOutputStream()) {
                if (in == null) throw new SecurityException("Cannot read selected SAF file.");
                byte[] chunk = new byte[8192];
                int n;
                while ((n = in.read(chunk)) != -1) {
                    if (received.size() + n > MAX_BYTES) throw new SecurityException("File too large.");
                    received.write(chunk, 0, n);
                }
                bytes = received.toByteArray();
            }
            if (doc.size >= 0 && doc.size != bytes.length)
                throw new SecurityException("Selected document changed during read.");
            out.add(new PackedFile(relative, bytes, fingerprint(bytes)));
        }
    }
    public static Packed pack(Context context, Uri treeUri) throws Exception {
        if (context == null || treeUri == null || !DocumentsContract.isTreeUri(treeUri))
            throw new SecurityException("Android system folder permission is required.");
        String rootId = DocumentsContract.getTreeDocumentId(treeUri);
        if (rootId == null || rootId.isEmpty()) throw new SecurityException("Missing folder tree ID.");
        Uri root = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootId);
        Document selected = readMeta(context, root);
        if (!DocumentsContract.Document.MIME_TYPE_DIR.equals(selected.mime))
            throw new SecurityException("Choose a folder, not a file.");
        String name = safeName(selected.name) + ".safolder";
        List<PackedFile> files = new ArrayList<>();
        walk(context, treeUri, rootId, "", 0, files, new HashSet<>());
        files.sort(Comparator.comparing(x -> x.relative));
        JSONArray entries = new JSONArray();
        int size = 0;
        for (PackedFile f : files) {
            entries.put(new JSONObject().put("path", f.relative).put("size", f.bytes.length)
                    .put("sha256", f.sha256));
            size += f.bytes.length;
            if (size > MAX_BYTES) throw new SecurityException("Folder files exceed 4 MiB.");
        }
        byte[] manifest = new JSONObject().put("version", 1).put("files", entries)
                .toString().getBytes(StandardCharsets.UTF_8);
        int total = MAGIC.length + 4 + manifest.length + size;
        if (manifest.length < 1 || manifest.length > MAX_MANIFEST || total > MAX_BYTES)
            throw new SecurityException("Folder package exceeds 4 MiB.");
        ByteArrayOutputStream output = new ByteArrayOutputStream(total);
        output.write(MAGIC);
        output.write(new byte[] { (byte)(manifest.length >>> 24), (byte)(manifest.length >>> 16),
                (byte)(manifest.length >>> 8), (byte)manifest.length });
        output.write(manifest);
        for (PackedFile f : files) output.write(f.bytes);
        byte[] packed = output.toByteArray();
        if (packed.length != total) throw new SecurityException("Folder packing size mismatch.");
        // Verifies per-file hash, exact safe manifest schema and no unaccounted bytes.
        LanFolderPackage.inspect(packed);
        return new Packed(name, packed, files.size());
    }
}
