package click.superagent.lanclient;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * Foreground lifetime for an ALREADY owner-approved direct-LAN V2 upload.
 * This service never pairs devices, opens a support session or approves a new
 * file. When backgrounded, new approval prompts fail closed in MainActivity.
 * STOP SHARING revokes the entire direct LAN server.
 */
public final class LanTransferForegroundService extends Service {
    private static final String CHANNEL = "superagent-lan-transfer";
    private static final String START = "click.superagent.lanclient.LAN_V2_FOREGROUND_START";
    private static final String STOP = "click.superagent.lanclient.LAN_V2_FOREGROUND_STOP";
    private static final int NOTICE_ID = 1846;
    private static volatile LanTransferForegroundService current;
    private static volatile LanClientServer requested;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile LanClientServer client;
    private volatile boolean running;
    private final Runnable expiryCheck = new Runnable() {
        @Override public void run() {
            LanClientServer target = client;
            if (!running || target == null || !target.isRunning() ||
                    !target.isV2TransferActive()) {
                shutdown(false);
                stopSelf();
                return;
            }
            main.postDelayed(this, 2000);
        }
    };
    public static synchronized boolean requestHold(Context context, LanClientServer server) {
        if (!MainActivity.canShowLanTransferNotification() || server == null ||
                !server.isRunning() || !server.isV2TransferActive()) return false;
        if (current != null && current.running && current.client == server) return true;
        requested = server;
        try {
            context.startForegroundService(new Intent(context, LanTransferForegroundService.class)
                    .setAction(START));
            return true;
        } catch (RuntimeException error) {
            requested = null;
            return false; // Owner stays foreground; onStop will close normal LAN listener.
        }
    }
    public static boolean isHolding(LanClientServer server) {
        if (server == null) return false;
        LanTransferForegroundService live = current;
        return (live != null && live.running && live.client == server) || requested == server;
    }
    public static void requestStop(Context context) {
        LanTransferForegroundService live = current;
        if (live != null) {
            live.shutdown(true);
            live.stopSelf();
        }
        requested = null;
    }
    @Override public void onCreate() {
        super.onCreate();
        current = this;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL,
                    "SuperAgent LAN file transfer", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Owner-approved file transfer in progress. Stop Sharing revokes access.");
            manager.createNotificationChannel(channel);
        }
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? "" : intent.getAction();
        if (STOP.equals(action)) {
            shutdown(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!START.equals(action) || running) return START_NOT_STICKY;
        LanClientServer candidate;
        synchronized (LanTransferForegroundService.class) {
            candidate = requested;
            requested = null;
        }
        if (candidate == null || !candidate.isRunning() || !candidate.isV2TransferActive()
                || !MainActivity.canShowLanTransferNotification()) {
            if (candidate != null && !MainActivity.hasVisibleOwner()) candidate.close();
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            Notification notification = notice();
            if (Build.VERSION.SDK_INT >= 29)
                startForeground(NOTICE_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            else startForeground(NOTICE_ID, notification);
        } catch (RuntimeException denied) {
            if (!MainActivity.hasVisibleOwner()) candidate.close();
            stopSelf();
            return START_NOT_STICKY;
        }
        client = candidate;
        running = true;
        main.postDelayed(expiryCheck, 2000);
        return START_NOT_STICKY;
    }
    private Notification notice() {
        Intent open = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 42, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 43,
                new Intent(this, LanTransferForegroundService.class).setAction(STOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("SuperAgent LAN file transfer active")
                .setContentText("Owner-approved transfer · Tap Stop Sharing to revoke")
                .setOngoing(true)
                .setContentIntent(content)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel,
                        "STOP SHARING", stop)
                .build();
    }
    private void shutdown(boolean ownerStopped) {
        running = false;
        main.removeCallbacks(expiryCheck);
        LanClientServer previous = client;
        client = null;
        // Once no transfer remains, foreground owner may retain local LAN UI.
        // In background or on explicit Stop Sharing, close/revoke the listener.
        if (previous != null && (ownerStopped || !MainActivity.hasVisibleOwner()))
            previous.close();
        stopForeground(STOP_FOREGROUND_REMOVE);
    }
    @Override public void onDestroy() {
        shutdown(false);
        if (current == this) current = null;
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
