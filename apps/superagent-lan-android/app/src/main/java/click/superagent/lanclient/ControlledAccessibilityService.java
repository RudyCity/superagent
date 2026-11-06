package click.superagent.lanclient;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.content.Context;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONObject;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Optional user-enabled Accessibility support for a visibly shared LAN session.
 * Never records events, reads messages or window contents, or runs unattended.
 * Commands are exact action/coordinate allowlisted by LanClientServer.
 */
public final class ControlledAccessibilityService extends AccessibilityService {
    private static volatile ControlledAccessibilityService active;
    private final Handler main = new Handler(Looper.getMainLooper());
    private AndroidUiSchema.Snapshot lastSchema;
    private boolean schemaDirty = true;
    private long lastElementActionAt;

    public static boolean enabled() { return active != null; }
    private static ControlledAccessibilityService requireEnabled() {
        ControlledAccessibilityService service = active;
        if (service == null || !RemoteControlPermit.canControl()) {
            throw new SecurityException("Remote input requires owner-enabled Accessibility, screen sharing, and active approved support session.");
        }
        return service;
    }

    @Override protected void onServiceConnected() {
        super.onServiceConnected();
        active = this;
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        // Invalidation only. Never inspect, log or persist event payloads.
        schemaDirty = true;
    }

    @Override public void onInterrupt() { }

    @Override public void onDestroy() {
        if (active == this) active = null;
        RemoteControlPermit.inputConsent(false);
        lastSchema = null;
        schemaDirty = true;
        super.onDestroy();
    }

    /**
     * All Accessibility tree operations run on the main Android thread.
     * Network threads wait up to 1200 ms without blocking UI.
     */
    private static <T> T onUi(Callable<T> task) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) return task.call();
        CountDownLatch ready = new CountDownLatch(1);
        AtomicReference<T> value = new AtomicReference<>();
        AtomicReference<Exception> failure = new AtomicReference<>();
        AtomicBoolean timedOut = new AtomicBoolean(false);
        ControlledAccessibilityService service = active;
        if (service == null) throw new SecurityException("Accessibility service not enabled.");
        service.main.post(() -> {
            try { if (!timedOut.get()) value.set(task.call()); }
            catch (Exception e) { failure.set(e); }
            finally { ready.countDown(); }
        });
        if (!ready.await(1200, TimeUnit.MILLISECONDS)) {
            timedOut.set(true);
            throw new IllegalStateException("Accessibility schema request timed out.");
        }
        if (failure.get() != null) throw failure.get();
        return value.get();
    }

    public static JSONObject schema(long knownRevision) throws Exception {
        ControlledAccessibilityService service = active;
        if (service == null || !RemoteControlPermit.canView())
            throw new SecurityException("Phone owner must approve capture and enable Accessibility.");
        if (knownRevision < 0 || knownRevision > 1_000_000_000L)
            throw new SecurityException("Invalid schema revision.");
        return onUi(() -> {
            if (active != service || !RemoteControlPermit.canView())
                throw new SecurityException("Schema authorization revoked.");
            long now = android.os.SystemClock.elapsedRealtime();
            if (service.lastSchema == null || service.schemaDirty || now - service.lastSchema.at > 1200) {
                AccessibilityNodeInfo root = service.getRootInActiveWindow();
                if (root == null) throw new IllegalStateException("Visible Accessibility tree unavailable.");
                try {
                    WindowManager wm = (WindowManager) service.getSystemService(Context.WINDOW_SERVICE);
                    if (wm == null) throw new IllegalStateException("Screen metrics unavailable.");
                    DisplayMetrics dm = new DisplayMetrics();
                    wm.getDefaultDisplay().getRealMetrics(dm);
                    service.lastSchema = AndroidUiSchema.collect(root, dm.widthPixels,
                            dm.heightPixels, service.lastSchema);
                    service.schemaDirty = false;
                } finally { root.recycle(); }
            }
            return service.lastSchema.response(knownRevision);
        });
    }

    /**
     * Semantic click requires matching revision/path/bounds on the active UI.
     * No raw coordinates, secret-field actions or stale UI references.
     */
    public static boolean clickElement(long revision, String elementId) throws Exception {
        ControlledAccessibilityService service = requireEnabled();
        if (elementId == null || elementId.length() > 48
                || !elementId.matches("0([.][0-9]{1,2}){0,12}"))
            throw new SecurityException("Invalid semantic element path.");
        return onUi(() -> {
            if (!RemoteControlPermit.canControl() || active != service)
                throw new SecurityException("Remote touch revoked.");
            AndroidUiSchema.Snapshot snapshot = service.lastSchema;
            long now = android.os.SystemClock.elapsedRealtime();
            if (snapshot == null || snapshot.revision != revision || service.schemaDirty
                    || now - snapshot.at > 1500 || now - service.lastElementActionAt < 250)
                throw new SecurityException("Stale UI schema. Refresh before acting.");
            Rect original = snapshot.clickableBounds.get(elementId);
            if (original == null) throw new SecurityException("Element not approved as clickable.");
            AccessibilityNodeInfo node = service.getRootInActiveWindow();
            if (node == null) throw new SecurityException("No active UI.");
            try {
                String[] steps = elementId.split("[.]");
                for (int i = 1; i < steps.length; i++) {
                    int index = Integer.parseInt(steps[i]);
                    AccessibilityNodeInfo next = node.getChild(index);
                    node.recycle();
                    node = next;
                    if (node == null) throw new SecurityException("UI element disappeared.");
                }
                Rect actual = new Rect();
                node.getBoundsInScreen(actual);
                if (!node.isVisibleToUser() || !node.isClickable() || !node.isEnabled()
                        || node.isPassword() || node.isEditable() || !original.equals(actual))
                    throw new SecurityException("UI element changed since snapshot.");
                boolean done = node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                if (done) {
                    service.lastElementActionAt = now;
                    service.schemaDirty = true;
                }
                return done;
            } finally { if (node != null) node.recycle(); }
        });
    }

    public static void tap(float x, float y) {
        ControlledAccessibilityService service = requireEnabled();
        service.gesture(x, y, x, y, 110);
    }

    public static void swipe(float x, float y, float endX, float endY, int durationMs) {
        ControlledAccessibilityService service = requireEnabled();
        if (durationMs < 100 || durationMs > 1500) throw new SecurityException("Swipe duration invalid.");
        service.gesture(x, y, endX, endY, durationMs);
    }

    public static void global(String action) {
        ControlledAccessibilityService service = requireEnabled();
        final int code;
        if ("back".equals(action)) code = GLOBAL_ACTION_BACK;
        else if ("home".equals(action)) code = GLOBAL_ACTION_HOME;
        else if ("recents".equals(action)) code = GLOBAL_ACTION_RECENTS;
        else throw new SecurityException("Unsupported navigation action.");
        service.main.post(() -> {
            if (RemoteControlPermit.canControl()) service.performGlobalAction(code);
        });
    }

    /**
     * Exact ACTION_SET_TEXT on the CURRENTLY FOCUSED EDITABLE non-password node.
     * Does not enumerate app windows, read existing text, use clipboard, or
     * inject passwords into sensitive fields.
     */
    public static void type(String text) {
        if (text == null || text.isEmpty() || text.length() > 160 || text.indexOf('\n') >= 0) {
            throw new SecurityException("Text must have 1-160 characters and no newline.");
        }
        ControlledAccessibilityService service = requireEnabled();
        service.main.post(() -> {
            if (!RemoteControlPermit.canControl()) return;
            AccessibilityNodeInfo root = service.getRootInActiveWindow();
            if (root == null) return;
            try {
                AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                if (focused == null) return;
                try {
                    if (!focused.isEditable() || focused.isPassword()) return;
                    Bundle args = new Bundle();
                    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
                    focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
                } finally { focused.recycle(); }
            } finally { root.recycle(); }
        });
    }

    private void gesture(float x, float y, float endX, float endY, int duration) {
        main.post(() -> {
            if (!RemoteControlPermit.canControl()) return;
            WindowManager windows = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
            if (windows == null) return;
            DisplayMetrics metrics = new DisplayMetrics();
            windows.getDefaultDisplay().getRealMetrics(metrics);
            int width = metrics.widthPixels;
            int height = metrics.heightPixels;
            if (width < 1 || height < 1) return;
            Path p = new Path();
            p.moveTo(x * width, y * height);
            p.lineTo(endX * width, endY * height);
            GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(p, 0, duration);
            dispatchGesture(new GestureDescription.Builder().addStroke(stroke).build(), null, null);
        });
    }
}
