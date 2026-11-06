package click.superagent.lanclient;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.lang.ref.WeakReference;

/**
 * Explicitly consented MediaProjection capture. Visible foreground notification
 * persists while the owner navigates other apps. Each capture starts with fresh
 * Android system consent; no cached capture Intents or reused projection tokens.
 * Images remain in memory and are served only to authenticated approved LAN sessions.
 */
public final class ScreenProjectionService extends Service {
    public static final String ACTION_START = "click.superagent.lanclient.START_SCREEN";
    public static final String ACTION_STOP = "click.superagent.lanclient.STOP_SCREEN";
    public static final String EXTRA_RESULT_CODE = "androidProjectionResultCode";
    public static final String EXTRA_RESULT_DATA = "androidProjectionResultData";

    private static final String CHANNEL = "superagent-lan-active-screen";
    private static final int NOTIFICATION_ID = 17845;
    private static final int MAX_WIDTH = 480;
    private static final int MAX_FRAME_BYTES = 210_000;
    private static volatile ScreenProjectionService current;

    private final Handler main = new Handler(android.os.Looper.getMainLooper());
    private HandlerThread captureThread;
    private Handler captureHandler;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private volatile Frame latest;
    // JPEG encoding is strictly on demand. Schema polling never requests pixels.
    private volatile boolean frameRequested;
    private volatile boolean active;
    private volatile long lastEncodeAt;
    private int imageWidth;
    private int imageHeight;

    public static final class Frame {
        public final String jpeg;
        public final int width;
        public final int height;
        private final long createdAt;
        Frame(String jpeg, int width, int height, long createdAt) {
            this.jpeg = jpeg; this.width = width; this.height = height; this.createdAt = createdAt;
        }
    }

    public static void stop(Context context) {
        if (current != null) {
            Intent stop = new Intent(context, ScreenProjectionService.class).setAction(ACTION_STOP);
            context.startService(stop);
        }
    }

    public static boolean isActive() {
        ScreenProjectionService service = current;
        return service != null && service.active;
    }

    public static Frame frame() {
        ScreenProjectionService service = current;
        if (service == null || !service.active || !RemoteControlPermit.canView()) {
            throw new SecurityException("Phone owner must start Android screen sharing during an approved support session.");
        }
        long requestedAt = SystemClock.elapsedRealtime();
        service.frameRequested = true;
        // A single explicit fallback capture; never encode frames continuously.
        for (int i = 0; i < 18; i++) {
            Frame frame = service.latest;
            if (frame != null && frame.createdAt >= requestedAt
                    && RemoteControlPermit.canView() && service.active) return frame;
            try { Thread.sleep(65); }
            catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Screen capture request interrupted.");
            }
        }
        service.frameRequested = false;
        throw new IllegalStateException("No new screenshot available. Change the screen or retry.");
    }

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager notifications =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (notifications != null) {
            notifications.createNotificationChannel(
                    new NotificationChannel(CHANNEL, "SuperAgent screen sharing",
                            NotificationManager.IMPORTANCE_LOW));
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            endCapture();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(intent.getAction()) || active || current != null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(NOTIFICATION_ID, notification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        try {
            int code = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
            Intent data;
            if (Build.VERSION.SDK_INT >= 33) {
                data = intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent.class);
            } else {
                data = intent.getParcelableExtra(EXTRA_RESULT_DATA);
            }
            if (code != android.app.Activity.RESULT_OK || data == null) {
                throw new SecurityException("System screen capture consent missing.");
            }
            MediaProjectionManager manager = (MediaProjectionManager)
                    getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            if (manager == null) throw new IllegalStateException("MediaProjection unavailable.");
            // Android 14+: each Intent/token is consumed exactly once.
            projection = manager.getMediaProjection(code, data);
            if (projection == null) throw new IllegalStateException("MediaProjection permission unavailable.");
            projection.registerCallback(new MediaProjection.Callback() {
                @Override public void onStop() {
                    main.post(() -> {
                        endCapture();
                        stopSelf();
                    });
                }
                @Override public void onCapturedContentResize(int width, int height) {
                    if (width < 1 || height < 1 || width > 10000 || height > 10000) return;
                    main.post(() -> resizeCapture(width, height));
                }
            }, main);
            WindowManager windows = (WindowManager) getSystemService(WINDOW_SERVICE);
            DisplayMetrics metrics = new DisplayMetrics();
            if (windows == null) throw new IllegalStateException("Display service unavailable");
            windows.getDefaultDisplay().getRealMetrics(metrics);
            int width = Math.max(1, metrics.widthPixels);
            int height = Math.max(1, metrics.heightPixels);
            captureThread = new HandlerThread("superagent-capture-frames");
            captureThread.start();
            captureHandler = new Handler(captureThread.getLooper());
            setupReader(width, height);
            display = projection.createVirtualDisplay(
                    "SuperAgent LAN owner-approved screen", imageWidth, imageHeight,
                    Math.max(120, metrics.densityDpi), DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    reader.getSurface(), null, main);
            active = true;
            current = this;
            RemoteControlPermit.projection(true);
            return START_NOT_STICKY;
        } catch (Exception error) {
            endCapture();
            stopSelf();
            return START_NOT_STICKY;
        }
    }

    private Notification notification() {
        Intent stop = new Intent(this, ScreenProjectionService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 0, stop,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent openIntent = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("SuperAgent · Android screen is being shared")
                .setContentText("Remote control active only with your permission. Tap STOP to end.")
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setContentIntent(openIntent)
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_menu_close_clear_cancel,
                        "STOP SHARING", stopIntent).build())
                .build();
    }

    private synchronized void setupReader(int screenWidth, int screenHeight) {
        // Max 480px wide, bounded pixels and <= 2 fps to avoid CPU/battery drain.
        float factor = Math.min(1f, (float) MAX_WIDTH / Math.max(1, screenWidth));
        imageWidth = Math.max(1, Math.round(screenWidth * factor));
        imageHeight = Math.max(1, Math.min(1080, Math.round(screenHeight * factor)));
        ImageReader old = reader;
        if (old != null) old.close();
        reader = ImageReader.newInstance(imageWidth, imageHeight, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(this::captureImage, captureHandler);
        latest = null;
    }

    private synchronized void resizeCapture(int width, int height) {
        if (!active || display == null) return;
        try {
            setupReader(width, height);
            display.resize(imageWidth, imageHeight, getResources().getDisplayMetrics().densityDpi);
            display.setSurface(reader.getSurface());
        } catch (RuntimeException error) {
            // Fail closed: no stale screenshots after resize fails.
            latest = null;
        }
    }

    private void captureImage(ImageReader source) {
        Image image = null;
        try {
            image = source.acquireLatestImage();
            if (image == null || !active || !RemoteControlPermit.canView()
                    || !frameRequested) return;
            long now = SystemClock.elapsedRealtime();
            if (now - lastEncodeAt < 500) return;
            lastEncodeAt = now;
            Image.Plane plane = image.getPlanes()[0];
            int w = image.getWidth(), h = image.getHeight();
            int stride = plane.getPixelStride();
            if (stride != 4 || w <= 0 || h <= 0 || w > MAX_WIDTH || h > 1080) return;
            int paddedWidth = plane.getRowStride() / stride;
            if (paddedWidth < w || paddedWidth > 2048) return;
            Bitmap padded = Bitmap.createBitmap(paddedWidth, h, Bitmap.Config.ARGB_8888);
            padded.copyPixelsFromBuffer(plane.getBuffer());
            Bitmap visible = Bitmap.createBitmap(padded, 0, 0, w, h);
            try (ByteArrayOutputStream buffer = new ByteArrayOutputStream(32_768)) {
                visible.compress(Bitmap.CompressFormat.JPEG, 48, buffer);
                byte[] bytes = buffer.toByteArray();
                if (bytes.length > 0 && bytes.length <= MAX_FRAME_BYTES) {
                    latest = new Frame(Base64.encodeToString(bytes, Base64.NO_WRAP),
                            w, h, SystemClock.elapsedRealtime());
                    frameRequested = false;
                }
            }
            visible.recycle();
            padded.recycle();
        } catch (Exception ignored) {
            latest = null;
        } finally {
            if (image != null) image.close();
        }
    }

    private synchronized void endCapture() {
        active = false;
        if (current == this) current = null;
        latest = null;
        frameRequested = false;
        RemoteControlPermit.projection(false);
        VirtualDisplay vd = display;
        display = null;
        if (vd != null) vd.release();
        ImageReader input = reader;
        reader = null;
        if (input != null) input.close();
        MediaProjection mp = projection;
        projection = null;
        if (mp != null) {
            try { mp.stop(); } catch (RuntimeException ignored) { }
        }
        HandlerThread thread = captureThread;
        captureThread = null;
        if (thread != null) thread.quitSafely();
        MainActivity.onScreenCaptureEnded();
    }

    @Override public void onDestroy() {
        endCapture();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
