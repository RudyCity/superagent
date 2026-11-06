package click.superagent.lanclient;

import android.graphics.Rect;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Privacy-reduced Android Accessibility view-tree snapshot.
 * NEVER reads getText(), getContentDescription(), hintText or personal input.
 * Emits roles, bounded normalized coordinates, and safe resource-id suffixes.
 * Ephemeral local node paths can be selected only for the exact snapshot revision.
 */
public final class AndroidUiSchema {
    private AndroidUiSchema() {}
    public static final int VERSION = 1;
    public static final int MAX_ELEMENTS = 96;
    public static final int MAX_SCAN = 512;
    public static final int MAX_DEPTH = 12;

    public static final class Snapshot {
        public final long revision;
        public final String digest;
        public final JSONObject full;
        public final long at;
        public final Map<String, Rect> clickableBounds;
        Snapshot(long revision, String digest, JSONObject full, Map<String, Rect> clickableBounds) {
            this.revision = revision;
            this.digest = digest;
            this.full = full;
            this.clickableBounds = clickableBounds;
            this.at = SystemClock.elapsedRealtime();
        }
        public JSONObject response(long knownRevision) throws Exception {
            if (knownRevision == revision) {
                return new JSONObject()
                    .put("version", VERSION)
                    .put("revision", revision)
                    .put("changed", false);
            }
            return new JSONObject(full.toString());
        }
    }

    static String safeRole(CharSequence cls) {
        if (cls == null) return "view";
        String raw = cls.toString();
        if (raw.endsWith("ImageButton")) return "image-button";
        if (raw.endsWith("Button")) return "button";
        if (raw.endsWith("Switch")) return "switch";
        if (raw.endsWith("CheckBox")) return "checkbox";
        if (raw.endsWith("RadioButton")) return "radio";
        if (raw.endsWith("EditText")) return "input";
        if (raw.endsWith("RecyclerView") || raw.endsWith("ListView")) return "list";
        if (raw.endsWith("ScrollView")) return "scroll";
        if (raw.endsWith("TabLayout")) return "tabs";
        if (raw.endsWith("TextView")) return "text";
        return "view";
    }

    /**
     * Resource-name suffixes (e.g. "submit_button") are often sufficient for
     * semantic targeting without exporting actual text, personal data or labels.
     */
    static String safeResourceId(String resource) {
        if (resource == null || resource.length() > 160) return "";
        int end = resource.lastIndexOf('/');
        String tail = end >= 0 ? resource.substring(end + 1) : resource;
        if (tail.length() < 2 || tail.length() > 48
                || !tail.matches("[A-Za-z_][A-Za-z0-9_.-]*")) return "";
        String lower = tail.toLowerCase(java.util.Locale.ROOT);
        for (String privateToken : new String[]{
            "password", "passwd", "secret", "otp", "token", "auth", "pin_",
            "credit", "card_number", "private", "phone", "email", "address",
            "message", "chat", "search_query"
        }) if (lower.contains(privateToken)) return "";
        return tail;
    }

    private static final class Entry {
        final AccessibilityNodeInfo node;
        final String path;
        final int depth;
        Entry(AccessibilityNodeInfo node, String path, int depth) {
            this.node = node; this.path = path; this.depth = depth;
        }
    }

    public static Snapshot collect(AccessibilityNodeInfo root, int screenWidth, int screenHeight,
                                   Snapshot prior) throws Exception {
        if (root == null || screenWidth < 1 || screenHeight < 1
                || screenWidth > 10000 || screenHeight > 10000) {
            throw new SecurityException("Accessibility screen structure unavailable.");
        }
        JSONArray nodes = new JSONArray();
        Map<String, Rect> clickable = new LinkedHashMap<>();
        ArrayDeque<Entry> pending = new ArrayDeque<>();
        pending.add(new Entry(AccessibilityNodeInfo.obtain(root), "0", 0));
        boolean truncated = false;
        int scanned = 0;
        while (!pending.isEmpty()) {
            Entry e = pending.removeFirst();
            AccessibilityNodeInfo n = e.node;
            try {
                scanned++;
                if (scanned > MAX_SCAN || nodes.length() >= MAX_ELEMENTS) {
                    truncated = true; break;
                }
                if (!n.isVisibleToUser()) continue;
                Rect bounds = new Rect();
                n.getBoundsInScreen(bounds);
                Rect clipped = new Rect(
                    Math.max(0,bounds.left), Math.max(0,bounds.top),
                    Math.min(screenWidth,bounds.right), Math.min(screenHeight,bounds.bottom));
                boolean validBounds = clipped.width() > 0 && clipped.height() > 0;
                boolean password = n.isPassword();
                boolean enabled = n.isEnabled();
                boolean editable = n.isEditable();
                boolean actionable = n.isClickable() && enabled && !editable && !password;
                boolean scrollable = n.isScrollable();
                boolean focusable = n.isFocusable();
                // Skip noninteractive and password nodes entirely; do not reveal
                // text field contents, raw content descriptions or package names.
                if (validBounds && !password && (actionable || scrollable || editable || focusable)) {
                    JSONObject box = new JSONObject()
                        .put("x", Math.round(clipped.left * 10000.0 / screenWidth) / 10000.0)
                        .put("y", Math.round(clipped.top * 10000.0 / screenHeight) / 10000.0)
                        .put("w", Math.round(clipped.width() * 10000.0 / screenWidth) / 10000.0)
                        .put("h", Math.round(clipped.height() * 10000.0 / screenHeight) / 10000.0);
                    String role = safeRole(n.getClassName());
                    JSONObject object = new JSONObject()
                        .put("id", e.path)
                        .put("role", role)
                        .put("bounds", box)
                        .put("clickable", actionable)
                        .put("enabled", enabled)
                        .put("editable", editable)
                        .put("scrollable", scrollable)
                        .put("focused", n.isFocused());
                    if (!editable) {
                        String resource = safeResourceId(n.getViewIdResourceName());
                        if (!resource.isEmpty()) object.put("resource", resource);
                    }
                    nodes.put(object);
                    if (actionable) clickable.put(e.path, clipped);
                }
                if (e.depth < MAX_DEPTH) {
                    int childLimit = Math.min(n.getChildCount(), 40);
                    for (int i = 0; i < childLimit; i++) {
                        AccessibilityNodeInfo child = n.getChild(i);
                        if (child != null) pending.addLast(new Entry(child, e.path + "." + i, e.depth + 1));
                    }
                    if (n.getChildCount() > childLimit) truncated = true;
                } else if (n.getChildCount() > 0) truncated = true;
            } finally {
                n.recycle();
            }
        }
        for (Entry e : pending) e.node.recycle();

        // Include the private window identity in digest comparison, but do
        // NOT expose it to the controller or WebView.
        String privateWindow = root.getPackageName() == null ? "" : root.getPackageName().toString();
        String canonical = privateWindow + "|" + screenWidth + "x" + screenHeight
                + "|" + truncated + "|" + nodes.toString();
        byte[] digestBytes = MessageDigest.getInstance("SHA-256")
                .digest(canonical.getBytes(StandardCharsets.UTF_8));
        StringBuilder digest = new StringBuilder(64);
        for (byte b : digestBytes) digest.append(String.format(java.util.Locale.US,"%02x",b & 255));
        long revision = prior == null ? 1 :
                prior.digest.equals(digest.toString()) ? prior.revision : prior.revision + 1;
        JSONObject full = new JSONObject()
            .put("version", VERSION)
            .put("revision", revision)
            .put("changed", true)
            .put("width", screenWidth)
            .put("height", screenHeight)
            .put("truncated", truncated)
            .put("nodes", nodes);
        return new Snapshot(revision, digest.toString(), full, clickable);
    }
}
