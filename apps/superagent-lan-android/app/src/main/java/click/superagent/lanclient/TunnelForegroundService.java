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

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Owner-started, visible Android foreground service for outbound HTTPS device support.
 * Credentials are process-memory-only; process death requires a fresh QR invitation.
 * The local TLS listener is bound to 127.0.0.1, never to a cellular or public interface.
 */
public final class TunnelForegroundService extends Service {
    private static final String CHANNEL = "superagent-device-tunnel";
    private static final String ACTION_START = "click.superagent.lanclient.TUNNEL_START";
    private static final String ACTION_STOP = "click.superagent.lanclient.TUNNEL_STOP";
    private static final int NOTIFICATION_ID = 1845;
    private static volatile TunnelForegroundService current;
    private static volatile PendingStart pending;
    private static volatile String lastStatus = "Tunnel OFF";

    private final AtomicBoolean active = new AtomicBoolean(false);
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile LanClientServer backend;
    private volatile TunnelRelayClient relay;
    private volatile long generation;

    private static final class PendingStart {
        final String setup, fileName;
        final byte[] file;
        PendingStart(String setup, String fileName, byte[] file) {
            this.setup = setup; this.fileName = fileName; this.file = file;
        }
    }

    public static synchronized void requestStart(
            Context context, String setup, String fileName, byte[] file) {
        if (!MainActivity.hasVisibleOwner())
            throw new IllegalStateException("Open SuperAgent on your phone to connect.");
        if (current != null && current.active.get())
            throw new IllegalStateException("Disconnect the existing tunnel first.");
        if (setup == null || setup.length() > 2048)
            throw new IllegalArgumentException("Invalid Device Tunnel setup.");
        pending = new PendingStart(setup, fileName, file);
        Intent intent = new Intent(context, TunnelForegroundService.class).setAction(ACTION_START);
        try {
            context.startForegroundService(intent);
        } catch (RuntimeException error) {
            pending = null;
            throw error;
        }
    }

    public static void requestStop(Context context) {
        TunnelForegroundService live = current;
        if (live != null) {
            live.shutdown("Tunnel disconnected by phone owner.");
            live.stopSelf();
            return;
        }
        pending = null;
    }

    public static boolean isActive() {
        TunnelForegroundService live = current;
        return live != null && live.active.get();
    }

    public static LanClientServer currentServer() {
        TunnelForegroundService live = current;
        return live == null ? null : live.backend;
    }

    public static String currentStatus() { return lastStatus; }

    @Override public void onCreate() {
        super.onCreate();
        current = this;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL,
                    "SuperAgent Device Tunnel", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Visible remote support session with a stop control.");
            manager.createNotificationChannel(channel);
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? "" : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            shutdown("Tunnel disconnected by phone owner.");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action) || active.get()) return START_NOT_STICKY;
        final PendingStart request;
        synchronized (TunnelForegroundService.class) {
            request = pending;
            pending = null;
        }
        if (request == null || !MainActivity.hasVisibleOwner()) {
            lastStatus = "Open SuperAgent and scan a fresh Connect QR.";
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            Notification notification = notification("Connecting to SuperAgent over HTTPS");
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (RuntimeException error) {
            lastStatus = "Cannot show tunnel service notification: " + error.getClass().getSimpleName();
            MainActivity.tunnelNotice(lastStatus);
            stopSelf();
            return START_NOT_STICKY;
        }
        active.set(true);
        long epoch = ++generation;
        showStatus("Connecting to SuperAgent over HTTPS...");
        new Thread(() -> openTunnel(request, epoch), "superagent-android-tunnel-start").start();
        return START_NOT_STICKY;
    }

    private void openTunnel(PendingStart request, long epoch) {
        LanClientServer local = new LanClientServer(getApplicationContext(),
                MainActivity::requestTunnelApproval, this::showStatus,
                MainActivity::executeTunnelApprovedAction);
        try {
            if (request.file != null && request.fileName != null)
                local.selectLocalFile(request.fileName, request.file);
            LanClientServer.Info info = local.startTunnelLoopback();
            if (!active.get() || epoch != generation) {
                local.close();
                return;
            }
            backend = local;
            TunnelRelayClient client = new TunnelRelayClient(message -> {
                if (!active.get() || epoch != generation) return;
                showStatus(message);
                if (message.startsWith("Device Tunnel stopped:")
                        || message.startsWith("QR pairing failed:")) {
                    main.post(() -> {
                        if (epoch == generation && active.get()) {
                            shutdown(message);
                            stopSelf();
                        }
                    });
                }
            });
            relay = client;
            if (!active.get() || epoch != generation) {
                client.stop();
                local.close();
                return;
            }
            client.start(request.setup, "127.0.0.1", info.port,
                    info.fingerprint, info.code, Build.MANUFACTURER + " " + Build.MODEL);
        } catch (Exception error) {
            local.close();
            String message = "Device Tunnel failed: " + safeError(error);
            main.post(() -> {
                if (active.get() && epoch == generation) {
                    shutdown(message);
                    stopSelf();
                }
            });
        }
    }

    private static String safeError(Exception error) {
        String value = error.getMessage();
        if (value == null || value.isEmpty()) value = error.getClass().getSimpleName();
        String safe = value.replaceAll("\\b\\d{8,12}\\b", "[code]");
        return safe.substring(0, Math.min(160, safe.length()));
    }

    private void showStatus(String message) {
        lastStatus = message;
        MainActivity.tunnelNotice(message);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null && active.get()) {
            main.post(() -> {
                if (active.get()) manager.notify(NOTIFICATION_ID, notification(message));
            });
        }
    }

    private Notification notification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, TunnelForegroundService.class).setAction(ACTION_STOP);
        PendingIntent stopAction = PendingIntent.getService(this, 1, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("SuperAgent device connection active")
                .setContentText(text.length() > 90 ? text.substring(0, 90) : text)
                .setContentIntent(content)
                .setOngoing(true)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel,
                        "STOP SHARING", stopAction)
                .build();
    }

    private void shutdown(String reason) {
        if (!active.getAndSet(false)) return;
        ++generation;
        TunnelRelayClient client = relay;
        relay = null;
        if (client != null) client.stop();
        LanClientServer local = backend;
        backend = null;
        if (local != null) local.close();
        RemoteControlPermit.revoke();
        ScreenProjectionService.stop(this);
        lastStatus = reason;
        MainActivity.tunnelNotice(reason);
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    @Override public void onDestroy() {
        shutdown("Device Tunnel stopped. Scan a fresh QR to reconnect.");
        if (current == this) current = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
