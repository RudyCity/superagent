package click.superagent.lanclient;

import android.app.Activity;
import android.Manifest;
import android.content.pm.PackageManager;
import android.content.pm.PackageInfo;
import android.app.NotificationManager;
import android.media.projection.MediaProjectionManager;
import android.media.projection.MediaProjectionConfig;
import android.database.Cursor;
import android.provider.OpenableColumns;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Arrays;
import android.os.Build;
import java.lang.ref.WeakReference;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.WindowManager;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.EditText;
import android.text.InputFilter;
import android.text.InputType;
import android.widget.ScrollView;
import android.widget.TextView;

import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import org.json.JSONObject;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

/** Foreground-only, on-screen and user-approved Android LAN diagnostics. */
public final class MainActivity extends Activity {
    private static final int SCREEN_REQUEST = 9001, NOTIFICATION_REQUEST = 9002, FILE_SELECT_REQUEST = 9003, FOLDER_SELECT_REQUEST = 9004, NOTIFICATION_SETUP_REQUEST = 9005;
    private static volatile WeakReference<MainActivity> currentActivity = new WeakReference<>(null);
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean requestingCapture;
    private byte[] sharedFileBytes;
    private String sharedFileName;
    private volatile boolean preparingFolder;
    private volatile LanClientServer server;
    private volatile TunnelRelayClient tunnelRelay;
    private volatile boolean visible;
    private volatile boolean launching;
    private AlertDialog approvalDialog;
    private final AtomicBoolean approvalPending = new AtomicBoolean(false);
    private TextView status, ip, code, fingerprint, paired, events, fileSelected;
    private Button start, stop, renew, revoke, copy, startScreen, stopScreen, touchToggle;
    private Button tunnelScan, tunnelConnect, tunnelDisconnect;
    private TextView screenState, tunnelState, qrScanStatus, permissionSummary;
    private Button permissionNext;
    private FrameLayout pageHost;
    private ScrollView[] pages;
    private Button[] tabButtons;
    private TextView dashboardStatus, dashboardConnection;
    private Button dashboardStop, manualSetupToggle;
    private LinearLayout manualSetupPanel;
    private int selectedTab = 0;
    private EditText segmentInput, tunnelSetupInput;
    private boolean qrScanInProgress;
    private String pendingQrPayload;

    private String appBuildLabel() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return "Version " + info.versionName + " · Build " + info.getLongVersionCode();
        } catch (PackageManager.NameNotFoundException ignored) {
            return "Version unavailable";
        }
    }

    private int dp(int n) { return AndroidUiKit.dp(this, n); }

    private TextView label(String value, int size, int color, boolean bold) {
        return AndroidUiKit.text(this, value, size, color, bold);
    }

    private void add(LinearLayout container, View child, int gap) {
        AndroidUiKit.add(container, child, gap);
    }

    private Button action(LinearLayout container, String title, Runnable callback) {
        Button button = AndroidUiKit.button(this, title, callback);
        add(container, button, 8);
        return button;
    }

    private LinearLayout section(LinearLayout page, String title) {
        return AndroidUiKit.panel(page, title);
    }

    private void showTab(int index) {
        if (pages == null || tabButtons == null || index < 0 || index >= pages.length) return;
        selectedTab = index;
        for (int i = 0; i < pages.length; i++) {
            pages[i].setVisibility(i == index ? View.VISIBLE : View.GONE);
            AndroidUiKit.activeTab(tabButtons[i], i == index);
        }
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putInt("selectedTab", selectedTab);
        super.onSaveInstanceState(state);
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(AndroidUiKit.CANVAS);
        getWindow().setNavigationBarColor(AndroidUiKit.CANVAS);

        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(AndroidUiKit.CANVAS);
        shell.setFitsSystemWindows(true);
        shell.addView(AndroidUiKit.header(this));

        LinearLayout homePage = AndroidUiKit.page(this);
        LinearLayout connectPage = AndroidUiKit.page(this);
        LinearLayout controlPage = AndroidUiKit.page(this);
        LinearLayout filesPage = AndroidUiKit.page(this);
        pageHost = new FrameLayout(this);
        pages = new ScrollView[] {
                AndroidUiKit.scroll(this, homePage),
                AndroidUiKit.scroll(this, connectPage),
                AndroidUiKit.scroll(this, controlPage),
                AndroidUiKit.scroll(this, filesPage)
        };
        for (ScrollView page : pages) pageHost.addView(page);
        shell.addView(pageHost, new LinearLayout.LayoutParams(-1, 0, 1f));

        LinearLayout navigation = AndroidUiKit.bottomBar(this);
        String[] labels = { "Home", "Connect", "Control", "Files" };
        tabButtons = new Button[labels.length];
        for (int i = 0; i < labels.length; i++) {
            final int destination = i;
            tabButtons[i] = AndroidUiKit.tab(this, labels[i], () -> showTab(destination));
            navigation.addView(tabButtons[i], new LinearLayout.LayoutParams(0, dp(50), 1f));
        }
        shell.addView(navigation);
        setContentView(shell);

        add(homePage, label("Overview", 24, AndroidUiKit.TEXT, true), 0);
        add(homePage, label("Connection, permissions and activity at a glance.", 13, AndroidUiKit.MUTED, false), 2);
        add(connectPage, label("Connect your device", 24, AndroidUiKit.TEXT, true), 0);
        add(connectPage, label("Scan the QR in SuperAgent Tray or use your local network.", 13, AndroidUiKit.MUTED, false), 2);
        add(controlPage, label("Screen & control", 24, AndroidUiKit.TEXT, true), 0);
        add(controlPage, label("Decide exactly what your paired controller can do.", 13, AndroidUiKit.MUTED, false), 2);
        add(filesPage, label("Private file transfer", 24, AndroidUiKit.TEXT, true), 0);
        add(filesPage, label("Share only the items you choose and approve.", 13, AndroidUiKit.MUTED, false), 2);

        LinearLayout layout = section(homePage, "DEVICE OVERVIEW");
        add(layout, label("Your phone. Your call.", 27, AndroidUiKit.TEXT, true), 2);
        add(layout, label("Secure support with permission at every step.", 14, AndroidUiKit.MUTED, false), 4);
        add(layout, label(appBuildLabel(), 12, AndroidUiKit.BLUE, false), 2);
        dashboardStatus = label("Not connected", 21, AndroidUiKit.TEXT, true);
        add(layout, dashboardStatus, 15);
        dashboardConnection = label("Connect your phone to SuperAgent Tray to begin.", 13,
                AndroidUiKit.MUTED, false);
        add(layout, dashboardConnection, 1);
        Button connectShortcut = action(layout, "Connect a device", () -> showTab(1));
        AndroidUiKit.primary(connectShortcut);
        action(layout, "Set up remote control", () -> showTab(2));
        action(layout, "Send or receive files", () -> showTab(3));
        dashboardStop = action(layout, "Stop all sharing", this::stopSharing);
        AndroidUiKit.destructive(dashboardStop);

        layout = section(homePage, "YOUR PRIVACY");
        add(layout, label("You stay in control", 19, AndroidUiKit.TEXT, true), 0);
        add(layout, label("Every pairing and support session requires approval on your phone. Screen capture and remote touch need their own separate consent. Stop sharing at any time.", 13, AndroidUiKit.MUTED, false), 3);

        layout = section(homePage, "RECENT ACTIVITY");
        events = label("No requests accepted while sharing is off.", 12, AndroidUiKit.MUTED, false);
        events.setTypeface(Typeface.MONOSPACE);
        events.setTextIsSelectable(true);
        add(layout, events, 4);

        layout = section(controlPage, "PERMISSIONS · YOUR CHOICE");
        add(layout, label("Optional screen assistance requires four separate Android permissions. Continue requests each step on this phone. Opening Android Settings ends the current sharing session; reconnect and approve a new support session afterward.", 13, AndroidUiKit.MUTED, false), 3);
        permissionSummary = label("Checking permissions...", 14, Color.WHITE, false);
        permissionSummary.setLineSpacing(dp(4), 1f);
        add(layout, permissionSummary, 4);
        permissionNext = action(layout, "Continue permission setup", this::continuePermissionSetup);
        AndroidUiKit.primary(permissionNext);
        action(layout, "Refresh permission status", this::refresh);

        layout = section(connectPage, "DIRECT LAN · OPTIONAL");
        add(layout, label("For direct LAN pairing, enter the same network segment as Windows. Connect QR sets up the tunnel automatically. This name is not an authentication credential.", 13, AndroidUiKit.MUTED, false), 2);
        segmentInput = new EditText(this);
        segmentInput.setSingleLine(true);
        segmentInput.setHint("e.g. support-office");
        segmentInput.setHintTextColor(AndroidUiKit.SUBTLE);
        segmentInput.setTextColor(Color.WHITE);
        segmentInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        segmentInput.setFilters(new InputFilter[]{new InputFilter.LengthFilter(64)});
        AndroidUiKit.field(segmentInput);
        add(layout, segmentInput, 4);

        layout = section(connectPage, "SHARING");
        LinearLayout sharingCard = layout;
        status = label("OFF — no access", 19, Color.WHITE, true);
        add(layout, status, 2);
        start = action(layout, "Start LAN sharing", this::startSharing);
        AndroidUiKit.primary(start);
        stop = action(layout, "Stop sharing", this::stopSharing);
        AndroidUiKit.destructive(stop);

        layout = section(connectPage, "DEVICE TUNNEL · QR CONNECT");
        LinearLayout connectQrCard = layout;
        add(layout, label("Scan the one-time QR shown in SuperAgent Tray. The phone enrolls and starts pairing automatically through outbound HTTPS; you only confirm the pairing approval on this phone.", 13, AndroidUiKit.MUTED, false), 2);
        tunnelScan = action(layout, "Scan QR & Connect", this::scanTunnelQr);
        AndroidUiKit.primary(tunnelScan);
        qrScanStatus = label("Ready to scan the Connection QR shown in SuperAgent Tray.", 13, AndroidUiKit.MUTED, false);
        add(layout, qrScanStatus, 2);
        add(layout, label("Scan with this app, not your phone's regular camera. Connection approval stays on this device.", 12, AndroidUiKit.MUTED, false), 4);
        tunnelState = label("Tunnel OFF", 14, AndroidUiKit.TEXT, true);
        add(layout, tunnelState, 8);
        tunnelDisconnect = action(layout, "Disconnect tunnel", this::disconnectTunnel);
        manualSetupToggle = action(layout, "Manual setup · Advanced", this::toggleManualSetup);

        manualSetupPanel = section(connectPage, "ADVANCED · MANUAL TUNNEL");
        manualSetupPanel.setVisibility(View.GONE);
        layout = manualSetupPanel;
        add(layout, label("Only use this if QR scanning is unavailable. Paste the setup JSON from your trusted SuperAgent Tray.", 12, AndroidUiKit.MUTED, false), 0);
        tunnelSetupInput = new EditText(this);
        tunnelSetupInput.setSingleLine(false);
        tunnelSetupInput.setMinLines(2);
        tunnelSetupInput.setMaxLines(4);
        tunnelSetupInput.setHint("Paste trusted tunnel setup JSON");
        tunnelSetupInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        tunnelSetupInput.setFilters(new InputFilter[]{new InputFilter.LengthFilter(1024)});
        AndroidUiKit.field(tunnelSetupInput);
        add(layout, tunnelSetupInput, 7);
        tunnelConnect = action(layout, "Connect with manual setup", this::connectTunnel);

        layout = section(connectPage, "PAIRING DETAILS");
        add(layout, label("Phone IP / port", 12, AndroidUiKit.MUTED, false), 0);
        ip = label("Not connected", 17, Color.WHITE, true);
        add(layout, ip, 0);
        add(layout, label("One-time 8-digit pairing code (2 minutes)", 12, AndroidUiKit.MUTED, false), 6);
        code = label("—", 26, Color.WHITE, true);
        code.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        add(layout, code, 0);
        renew = action(layout, "Generate new code", () -> {
            LanClientServer live = server;
            if (live != null) code.setText(live.rotateCode());
        });
        add(layout, label("SHA-256 TLS certificate fingerprint", 12, AndroidUiKit.MUTED, false), 6);
        fingerprint = label("Not generated", 12, Color.WHITE, false);
        fingerprint.setTypeface(Typeface.MONOSPACE);
        fingerprint.setTextIsSelectable(true);
        fingerprint.setTextSize(11);
        add(layout, fingerprint, 0);
        copy = action(layout, "Copy fingerprint", () -> {
            LanClientServer live = server;
            if (live == null || live.currentInfo() == null) return;
            ClipboardManager mgr = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (mgr != null) mgr.setPrimaryClip(ClipData.newPlainText("Target certificate SHA-256", live.currentInfo().fingerprint));
            notifyEvent("Fingerprint copied. Compare all 64 digits on the controller.");
        });

        layout = section(connectPage, "LOCAL APPROVAL");
        paired = label("No paired controllers", 15, Color.WHITE, true);
        add(layout, paired, 0);
        add(layout, label("Approve pairing and every support session. Every additional Android action requires its own on-screen approval. Only you can change system settings.", 13, AndroidUiKit.MUTED, false), 4);
        revoke = action(layout, "Revoke all paired access", () -> {
            LanClientServer live = server;
            if (live != null) {
                live.revoke();
                code.setText(live.rotateCode());
                refresh();
            }
        });
        layout = section(connectPage, "ASSISTED CONTROLS");
        add(layout, label("SuperAgent may request Wi-Fi, Bluetooth, display, battery, storage, apps or date/time Settings, or a one-step media volume change. Every action requires approval; opening Settings stops sharing.", 13, AndroidUiKit.MUTED, false), 4);
        action(layout, "Open Android settings", () -> {
            stopSharing();
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        });

        layout = section(controlPage, "SCREEN CONTROL · OPT IN");
        add(layout, label("Android will ask before sharing your screen. Remote taps are optional and require separate Accessibility and on-phone consent.", 13, AndroidUiKit.MUTED, false), 5);
        screenState = label("Screen OFF · Remote touch OFF", 15, Color.WHITE, true);
        add(layout, screenState, 4);
        action(layout, "Request Accessibility setup", this::requestAccessibilitySetup);
        startScreen = action(layout, "Share screen", this::beginScreenConsent);
        AndroidUiKit.primary(startScreen);
        stopScreen = action(layout, "Stop screen & revoke", this::stopSharing);
        AndroidUiKit.destructive(stopScreen);
        touchToggle = action(layout, "Allow remote taps and swipes", this::toggleRemoteInput);
        add(layout, label("Remote interaction can affect other apps. Do not open passwords or financial data. Secure screens may block capture. STOP is available in Android notifications.", 12, AndroidUiKit.MUTED, false), 6);
        layout = section(filesPage, "SEND FILES · OWNER APPROVAL");
        add(layout, label("Send a selected Android document to Windows or receive into Downloads/SuperAgent LAN. 4 MiB maximum per file. Each transfer needs an on-phone APPROVE.", 13, AndroidUiKit.MUTED, false), 6);
        fileSelected = label("No document selected", 13, Color.WHITE, true);
        add(layout, fileSelected, 2);
        action(layout, "Choose document to share", () -> {
            stopSharing();
            Intent chooser = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            startActivityForResult(chooser, FILE_SELECT_REQUEST);
        });
        action(layout, "Choose a folder", () -> {
            stopSharing();
            Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(picker, FOLDER_SELECT_REQUEST);
        });
        add(layout, label("Only the selected files leave this phone. Transfers are verified and limited to 4 MiB; unsafe files and unsupported folders are refused.", 12, AndroidUiKit.MUTED, false), 4);
        action(layout, "Clear selected file or folder", () -> {
            if (sharedFileBytes != null) Arrays.fill(sharedFileBytes, (byte) 0);
            sharedFileBytes = null; sharedFileName = null;
            fileSelected.setText("No document selected");
            stopSharing();
        });
        connectPage.removeView(connectQrCard);
        connectPage.addView(connectQrCard, 2);
        connectPage.removeView(sharingCard);
        connectPage.addView(sharingCard, 3);
        // Keep segment settings visible, but secondary to the one-tap QR flow.
        showTab(state == null ? 0 : Math.max(0, Math.min(3, state.getInt("selectedTab", 0))));
        refresh();
    }

    private void refresh() {
        LanClientServer live = server;
        boolean on = live != null && live.isRunning();
        if (start != null) start.setEnabled(!on && !launching && !preparingFolder);
        if (segmentInput != null) segmentInput.setEnabled(!on && !launching);
        if (stop != null) stop.setEnabled(on);
        if (dashboardStop != null) dashboardStop.setEnabled(on || ScreenProjectionService.isActive());
        if (renew != null) renew.setEnabled(on);
        if (revoke != null) revoke.setEnabled(on);
        if (copy != null) copy.setEnabled(on);
        boolean tunnelOn = tunnelRelay != null && tunnelRelay.isRunning();
        if (tunnelSetupInput != null) tunnelSetupInput.setEnabled(on && !tunnelOn && !launching);
        if (tunnelScan != null) tunnelScan.setEnabled(!tunnelOn && !launching && !preparingFolder && !qrScanInProgress);
        if (tunnelConnect != null) tunnelConnect.setEnabled(on && !tunnelOn);
        if (tunnelDisconnect != null) tunnelDisconnect.setEnabled(tunnelOn);
        if (tunnelState != null) tunnelState.setText(tunnelOn ? "Tunnel ON · outbound HTTPS" : "Tunnel OFF");
        if (paired != null) paired.setText(on ? live.state() : "No paired controllers");
        if (dashboardStatus != null) {
            dashboardStatus.setText(tunnelOn ? "Secure tunnel running"
                    : on ? "LAN sharing is active" : "Device is offline");
            dashboardStatus.setTextColor(tunnelOn || on ? AndroidUiKit.ACCENT : AndroidUiKit.TEXT);
        }
        if (dashboardConnection != null) {
            dashboardConnection.setText(tunnelOn
                    ? (RemoteControlPermit.hasApprovedSession() ? "Support session approved · Owner controls remain active"
                        : "Tunnel running · Waiting for session approval")
                    : on ? "Ready for local pairing · " + live.state()
                    : "Tap Connect to pair securely using QR or your local network.");
        }
        if (startScreen != null) startScreen.setEnabled(on && RemoteControlPermit.hasApprovedSession()
                && !requestingCapture && !ScreenProjectionService.isActive());
        if (stopScreen != null) stopScreen.setEnabled(on || ScreenProjectionService.isActive());
        if (touchToggle != null) {
            touchToggle.setEnabled(on && RemoteControlPermit.canView() && ControlledAccessibilityService.enabled());
            touchToggle.setText(RemoteControlPermit.canControl()
                    ? "DISABLE REMOTE TOUCH" : "Allow remote taps / swipes / text");
        }
        if (screenState != null) screenState.setText(
                "Screen: " + (ScreenProjectionService.isActive() ? "SHARING" : "OFF")
                + "  · Touch: " + (RemoteControlPermit.canControl() ? "ENABLED" : "OFF")
                + "  · Accessibility: " + (ControlledAccessibilityService.enabled() ? "enabled" : "not enabled"));
        if (permissionSummary != null) {
            permissionSummary.setText(
                    "1. Notifications: " + (notificationsReady() ? "READY" : "ENABLE REQUIRED")
                    + "\n2. Accessibility: " + (ControlledAccessibilityService.enabled() ? "READY" : "ENABLE REQUIRED")
                    + "\n3. Screen sharing: " + (ScreenProjectionService.isActive() ? "ACTIVE"
                            : RemoteControlPermit.hasApprovedSession() ? "ANDROID CONSENT REQUIRED" : "APPROVED SESSION REQUIRED")
                    + "\n4. Remote touch: " + (RemoteControlPermit.canControl() ? "ACTIVE"
                            : RemoteControlPermit.canView() && ControlledAccessibilityService.enabled()
                            ? "PHONE APPROVAL REQUIRED" : "WAITING FOR SCREEN ACCESS"));
        }
        if (permissionNext != null) {
            permissionNext.setEnabled(!requestingCapture);
            permissionNext.setText(!notificationsReady() ? "Step 1 · Enable notifications"
                    : !ControlledAccessibilityService.enabled() ? "Step 2 · Enable Accessibility"
                    : !RemoteControlPermit.hasApprovedSession() ? "Step 3 · Approve a support session"
                    : !ScreenProjectionService.isActive() ? "Step 3 · Request screen sharing"
                    : !RemoteControlPermit.canControl() ? "Step 4 · Approve remote touch"
                    : "Remote control ready · Review status");
        }
    }

    private void toggleManualSetup() {
        if (manualSetupPanel == null) return;
        boolean expanded = manualSetupPanel.getVisibility() != View.VISIBLE;
        manualSetupPanel.setVisibility(expanded ? View.VISIBLE : View.GONE);
        if (manualSetupToggle != null) manualSetupToggle.setText(
                expanded ? "Hide manual setup" : "Manual setup · Advanced");
    }

    private boolean notificationsReady() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            return false;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        return manager != null && manager.areNotificationsEnabled();
    }

    private void continuePermissionSetup() {
        if (!notificationsReady()) {
            requestNotificationSetup();
        } else if (!ControlledAccessibilityService.enabled()) {
            requestAccessibilitySetup();
        } else if (!RemoteControlPermit.hasApprovedSession()) {
            new AlertDialog.Builder(this)
                    .setTitle("Approve a support session first")
                    .setMessage("Connect using the Connect QR if sharing is off, then request a support session in Windows Tray > LAN Devices. Approve on this phone. Pairing alone does not authorize screen control.")
                    .setPositiveButton("OK", null).show();
        } else if (!ScreenProjectionService.isActive()) {
            beginScreenConsent();
        } else if (!RemoteControlPermit.canControl()) {
            toggleRemoteInput();
        } else {
            new AlertDialog.Builder(this)
                    .setTitle("Remote control is ready")
                    .setMessage("Screen sharing and remote-touch approval are active for this support session. You can stop sharing or revoke access on this phone.")
                    .setPositiveButton("OK", null).show();
        }
        refresh();
    }

    private void requestNotificationSetup() {
        if (notificationsReady()) { notifyEvent("App notifications are already enabled."); return; }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_SETUP_REQUEST);
            return;
        }
        promptNotificationSettings();
    }

    private void promptNotificationSettings() {
        new AlertDialog.Builder(this)
                .setTitle("Enable SuperAgent notifications")
                .setMessage("Visible notifications are required for screen sharing and a STOP SHARING control. Open this app's notification settings and enable notifications manually. This will disconnect current sharing; reconnect afterward.")
                .setNegativeButton("CANCEL", null)
                .setPositiveButton("OPEN SETTINGS", (dialog, which) -> {
                    stopSharing();
                    try {
                        startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
                    } catch (android.content.ActivityNotFoundException unavailable) {
                        startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                                .setData(android.net.Uri.parse("package:" + getPackageName())));
                    }
                }).show();
    }

    private void requestAccessibilitySetup() {
        if (ControlledAccessibilityService.enabled()) {
            notifyEvent("SuperAgent remote touch Accessibility is already enabled.");
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Enable remote-touch Accessibility")
                .setMessage("Android requires you to enable SuperAgent remote touch manually in Accessibility settings. SuperAgent cannot turn it on for you. This is sensitive: only enable it for trusted screen support. Opening Settings ends current sharing; reconnect and approve a new session after returning.")
                .setNegativeButton("CANCEL", null)
                .setPositiveButton("OPEN ACCESSIBILITY", (dialog, which) -> {
                    stopSharing();
                    try {
                        startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
                    } catch (android.content.ActivityNotFoundException unavailable) {
                        notifyEvent("Accessibility settings are unavailable on this device.");
                    }
                }).show();
    }

    private void notifyEvent(String text) {
        main.post(() -> {
            if (events != null) {
                String previous = events.getText().toString();
                String next = "• " + text + "\n" + previous;
                events.setText(next.substring(0, Math.min(next.length(), 1300)));
                if (text.startsWith("Paired controller") && code != null) {
                    code.setText("USED — generate a new code");
                }
            }
            refresh();
        });
    }

    private void startSharing() {
        if (server != null || launching || preparingFolder) return;
        final String segmentName;
        try {
            segmentName = LanClientServer.normalizeSegmentName(segmentInput.getText().toString());
        } catch (IllegalArgumentException invalid) {
            segmentInput.setError(invalid.getMessage());
            status.setText("OFF — valid network segment required");
            return;
        }
        launching = true;
        status.setText("Starting secure LAN listener...");
        refresh();
        new Thread(() -> {
            LanClientServer pending = new LanClientServer(
                    this, this::requestApproval, this::notifyEvent, this::executeApprovedAction);
            try {
                if (sharedFileBytes != null && sharedFileName != null)
                    pending.selectLocalFile(sharedFileName, sharedFileBytes);
                LanClientServer.Info info = pending.start(segmentName);
                main.post(() -> {
                    launching = false;
                    if (!visible) { pending.close(); refresh(); return; }
                    server = pending;
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    status.setText("ON — " + info.transport + " · segment " + segmentName);
                    ip.setText(info.ip + ":" + info.port);
                    code.setText(info.code);
                    fingerprint.setText(info.fingerprint);
                    refresh();
                });
            } catch (Exception error) {
                pending.close();
                main.post(() -> {
                    launching = false;
                    status.setText("OFF — start failed");
                    notifyEvent("Cannot start: " + error.getClass().getSimpleName() + " · " + error.getMessage());
                    refresh();
                });
            }
        }, "superagent-android-client-start").start();
    }

    private void qrFeedback(String message) {
        if (qrScanStatus != null) qrScanStatus.setText(message);
        notifyEvent(message);
    }

    // The Google Play Services scanner opens a separate Activity. Its result may
    // arrive while our Activity is stopped; no listener or tunnel may start then.
    private void connectPendingQrWhenForeground() {
        if (!visible || isFinishing() || launching || preparingFolder || pendingQrPayload == null) return;
        String setup = pendingQrPayload;
        pendingQrPayload = null;
        qrFeedback("QR read. Starting secure connection...");
        connectTunnelFromQr(setup);
    }

    private boolean isConnectQrPayload(String raw) {
        try {
            JSONObject qr = new JSONObject(raw);
            return "sat".equals(qr.optString("k", ""))
                    || "superagent-device-tunnel".equals(qr.optString("kind", ""));
        } catch (org.json.JSONException invalidQr) {
            return false;
        }
    }

    private void scanTunnelQr() {
        if (qrScanInProgress) return;
        if (tunnelRelay != null && tunnelRelay.isRunning()) {
            qrFeedback("Device Tunnel is already running. Disconnect before scanning another QR.");
            return;
        }
        qrScanInProgress = true;
        refresh();
        try {
            GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                    .build();
            GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(this, options);
            qrFeedback("Opening QR scanner. Scan the Connection QR in SuperAgent Tray. Hold the phone steady about 20–35 cm from the QR.");
            scanner.startScan()
                    .addOnSuccessListener(barcode -> {
                        qrScanInProgress = false;
                        String raw = barcode.getRawValue();
                        if (raw == null || raw.isEmpty() || raw.length() > 2048) {
                            qrFeedback("QR rejected. Scan a fresh Connect QR from SuperAgent Tray.");
                        } else if (!isConnectQrPayload(raw)) {
                            qrFeedback(raw.startsWith("https://")
                                    ? "This is an APK download QR. In Tray choose Create connect QR instead."
                                    : "Wrong QR format. In Tray choose Create connect QR and scan it here.");
                        } else {
                            pendingQrPayload = raw;
                            qrFeedback("QR detected. Returning to SuperAgent to connect...");
                            // Wait for scanner dismissal; onStart also drains if this callback
                            // arrived before the Activity returned to foreground.
                            main.postDelayed(this::connectPendingQrWhenForeground, 700);
                        }
                        refresh();
                    })
                    .addOnCanceledListener(() -> {
                        qrScanInProgress = false;
                        qrFeedback("QR scan cancelled. Tap Scan QR & Connect to retry.");
                        refresh();
                    })
                    .addOnFailureListener(error -> {
                        qrScanInProgress = false;
                        qrFeedback("QR scanner failed (" + error.getClass().getSimpleName()
                                + "). Update Google Play Services or use manual setup JSON.");
                        refresh();
                    });
        } catch (Exception error) {
            qrScanInProgress = false;
            qrFeedback("QR scanner unavailable (" + error.getClass().getSimpleName()
                    + "). Update Google Play Services or use manual setup JSON.");
            refresh();
        }
    }

    private void connectTunnelFromQr(String setup) {
        if (!visible || isFinishing()) {
            pendingQrPayload = setup;
            return;
        }
        LanClientServer live = server;
        if (live != null && live.isRunning() && live.currentInfo() != null) {
            String freshPairingCode = live.rotateCode();
            if (code != null) code.setText("AUTO · QR pairing");
            connectTunnelSetup(setup, freshPairingCode);
            return;
        }
        if (launching || preparingFolder) {
            notifyEvent("Device sharing is still starting; scan again after it is ready.");
            return;
        }
        launching = true;
        status.setText("Starting secure QR tunnel engine...");
        refresh();
        new Thread(() -> {
            LanClientServer pending = new LanClientServer(
                    this, this::requestApproval, this::notifyEvent, this::executeApprovedAction);
            try {
                if (sharedFileBytes != null && sharedFileName != null)
                    pending.selectLocalFile(sharedFileName, sharedFileBytes);
                LanClientServer.Info info = pending.start("qr-tunnel");
                main.post(() -> {
                    launching = false;
                    if (!visible) { pending.close(); refresh(); return; }
                    server = pending;
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    status.setText("ON — QR tunnel · " + info.transport);
                    ip.setText(info.ip + ":" + info.port);
                    code.setText("AUTO · QR pairing");
                    fingerprint.setText(info.fingerprint);
                    if (segmentInput != null && segmentInput.getText().toString().trim().isEmpty())
                        segmentInput.setText("qr-tunnel");
                    refresh();
                    connectTunnelSetup(setup, info.code);
                });
            } catch (Exception error) {
                pending.close();
                main.post(() -> {
                    launching = false;
                    status.setText("OFF — QR connection failed");
                    qrFeedback("Cannot start QR tunnel engine: " + error.getMessage());
                    refresh();
                });
            }
        }, "superagent-android-qr-start").start();
    }

    private void connectTunnel() {
        String setup = tunnelSetupInput == null ? "" : tunnelSetupInput.getText().toString().trim();
        if (setup.isEmpty()) {
            if (tunnelSetupInput != null) tunnelSetupInput.setError("Paste Device Tunnel setup JSON from SuperAgent Tray.");
            return;
        }
        connectTunnelSetup(setup, null);
    }

    private void connectTunnelSetup(String setup, String pairingCodeOverride) {
        LanClientServer live = server;
        LanClientServer.Info info = live == null ? null : live.currentInfo();
        if (live == null || !live.isRunning() || info == null) {
            notifyEvent("Start device sharing before connecting Device Tunnel.");
            return;
        }
        TunnelRelayClient existing = tunnelRelay;
        if (existing != null && existing.isRunning()) return;
        try {
            TunnelRelayClient relay = new TunnelRelayClient(message -> {
                notifyEvent(message);
                if (message.startsWith("Device Tunnel") || message.startsWith("QR pairing")) {
                    main.post(() -> {
                        if (qrScanStatus != null) qrScanStatus.setText(message);
                    });
                }
            });
            String pairingCode = pairingCodeOverride == null ? info.code : pairingCodeOverride;
            relay.start(setup, info.ip, info.port, info.fingerprint, pairingCode,
                    Build.MANUFACTURER + " " + Build.MODEL);
            tunnelRelay = relay;
            if (tunnelSetupInput != null) tunnelSetupInput.setText("");
            notifyEvent("Connecting reverse HTTPS Device Tunnel...");
            refresh();
        } catch (Exception error) {
            tunnelRelay = null;
            qrFeedback("Cannot connect tunnel: " + error.getMessage());
            refresh();
        }
    }

    private void disconnectTunnel() {
        TunnelRelayClient relay = tunnelRelay;
        tunnelRelay = null;
        if (relay != null) relay.stop();
        notifyEvent("Device Tunnel disconnected.");
        refresh();
    }

    private void stopSharing() {
        TunnelRelayClient relay = tunnelRelay;
        tunnelRelay = null;
        if (relay != null) relay.stop();
        RemoteControlPermit.revoke();
        ScreenProjectionService.stop(this);
        LanClientServer old = server;
        server = null;
        if (old != null) old.close();
        if (approvalDialog != null) approvalDialog.dismiss();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (status != null) status.setText("OFF — no access");
        if (ip != null) ip.setText("Not connected");
        if (code != null) code.setText("—");
        if (fingerprint != null) fingerprint.setText("Not generated");
        refresh();
    }

    private void executeApprovedAction(String command, BooleanSupplier stillAuthorized) {
        // Give TLS acknowledgement time to flush before leaving the foreground.
        main.postDelayed(() -> {
            if (!visible || server == null || !server.isRunning()
                    || !stillAuthorized.getAsBoolean()) {
                notifyEvent("Action cancelled: support stopped, expired or revoked.");
                return;
            }
            try {
                if (AndroidSupportActions.isVolumeAction(command)) {
                    AndroidSupportActions.adjustMediaVolume(this, command);
                    notifyEvent("Owner-approved media volume changed one step.");
                } else {
                    Intent intent = AndroidSupportActions.intent(this, command);
                    notifyEvent("Owner-approved Settings screen opening; sharing will stop.");
                    stopSharing();
                    startActivity(intent);
                }
            } catch (Exception error) {
                notifyEvent("Requested Android action is unavailable on this device.");
            }
        }, 600);
    }

    private boolean requestApproval(String kind, String controller, String address, int seconds) {
        if (!visible || isFinishing() || !approvalPending.compareAndSet(false, true)) return false;
        CountDownLatch latch = new CountDownLatch(1);
        AtomicBoolean allowed = new AtomicBoolean(false);
        main.post(() -> {
            if (!visible || isFinishing()) { latch.countDown(); return; }
            approvalDialog = new AlertDialog.Builder(this)
                    .setTitle(kind.startsWith("file:") ? "Approve file transfer?"
                            : kind.startsWith("action:") ? "Approve Android support action?"
                            : kind.equals("pair") ? "Approve controller pairing?" : "Approve support session?")
                    .setMessage("Controller: " + controller + "\nLocal IP: " + address
                            + (kind.startsWith("file:")
                              ? String.valueOf((char)10) + String.valueOf((char)10) + kind.substring(5)
                                + String.valueOf((char)10) + "Approve each transfer. Incoming files: Downloads/SuperAgent LAN."
                              : kind.startsWith("action:")
                              ? "\n\nAction requested: "
                                + AndroidSupportActions.description(kind.substring(7))
                                + "\n\nThe owner must approve. Opening Settings ends sharing; only the owner can change settings. Volume changes one step."
                              : "\n\nApprove only someone you trust. You can revoke or stop at any moment."))
                    .setPositiveButton("APPROVE", (dialog, which) -> {
                        allowed.set(true);
                        latch.countDown();
                    })
                    .setNegativeButton("DENY", (dialog, which) -> latch.countDown())
                    .setOnCancelListener(dialog -> latch.countDown())
                    .create();
            approvalDialog.setOnDismissListener(dialog -> latch.countDown());
            approvalDialog.show();
        });
        try {
            if (!latch.await(Math.min(seconds, 90), TimeUnit.SECONDS)) return false;
            return visible && allowed.get();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return false;
        } finally {
            approvalPending.set(false);
            main.post(() -> {
                if (approvalDialog != null) approvalDialog.dismiss();
                approvalDialog = null;
            });
        }
    }

    public static void onScreenCaptureEnded() {
        MainActivity owner = currentActivity.get();
        if (owner != null) owner.main.post(() -> {
            if (owner.server != null) owner.stopSharing();
            owner.refresh();
        });
    }

    private void beginScreenConsent() {
        if (!visible || server == null || !server.isRunning()
                || !RemoteControlPermit.hasApprovedSession()) {
            notifyEvent("Pair and approve a LAN session first.");
            return;
        }
        if (ScreenProjectionService.isActive() || requestingCapture) return;
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
            return;
        }
        NotificationManager notices = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (notices == null || !notices.areNotificationsEnabled()) {
            notifyEvent("Visible notifications are required for screen sharing.");
            promptNotificationSettings();
            return;
        }
        MediaProjectionManager projection = (MediaProjectionManager)
                getSystemService(MEDIA_PROJECTION_SERVICE);
        if (projection == null) { notifyEvent("MediaProjection unavailable on this phone."); return; }
        requestingCapture = true;
        refresh();
        // If the Android consent sheet is abandoned, never keep a LAN
        // listener active while this Activity is hidden indefinitely.
        main.postDelayed(() -> {
            if (requestingCapture && !ScreenProjectionService.isActive()) {
                requestingCapture = false;
                stopSharing();
                notifyEvent("Screen-capture consent timed out; all LAN access revoked.");
            }
        }, 60_000);
        // Full-display consent aligns screenshot pixels with normalized taps.
        // Android still shows its native, mandatory permission dialog each session.
        Intent captureIntent = Build.VERSION.SDK_INT >= 34
                ? projection.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                : projection.createScreenCaptureIntent();
        startActivityForResult(captureIntent, SCREEN_REQUEST);
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == NOTIFICATION_REQUEST) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) beginScreenConsent();
            else {
                notifyEvent("Screen sharing blocked: notification permission denied.");
                promptNotificationSettings();
            }
        } else if (code == NOTIFICATION_SETUP_REQUEST) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && notificationsReady())
                notifyEvent("Notifications enabled. Continue remote control setup.");
            else {
                notifyEvent("Notifications remain disabled. Enable them in Android app settings.");
                promptNotificationSettings();
            }
            refresh();
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent result) {
        super.onActivityResult(requestCode, resultCode, result);
        if (requestCode == FILE_SELECT_REQUEST) {
            if (resultCode != RESULT_OK || result == null || result.getData() == null) return;
            try {
                android.net.Uri uri = result.getData();
                String name = null;
                try (Cursor rows = getContentResolver().query(uri,
                        new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                    if (rows != null && rows.moveToFirst()) name = rows.getString(0);
                }
                name = LanFileExchange.name(name);
                try (InputStream input = getContentResolver().openInputStream(uri);
                     ByteArrayOutputStream file = new ByteArrayOutputStream()) {
                    if (input == null) throw new SecurityException("Cannot open document.");
                    byte[] buffer = new byte[8192];
                    int n;
                    while ((n = input.read(buffer)) >= 0) {
                        if (file.size() + n > LanFileExchange.MAX_BYTES)
                            throw new SecurityException("Document is larger than 4 MiB.");
                        file.write(buffer, 0, n);
                    }
                    byte[] bytes = file.toByteArray();
                    if (bytes.length == 0) throw new SecurityException("Empty file.");
                    if (sharedFileBytes != null) Arrays.fill(sharedFileBytes, (byte) 0);
                    sharedFileBytes = bytes; sharedFileName = name;
                    fileSelected.setText(name + " · " + bytes.length + " bytes");
                    notifyEvent("Document staged. Tap Start sharing and approve the file request.");
                }
            } catch (Exception e) {
                notifyEvent("Document not selected: unsafe filename, size or access.");
            }
            return;
        }
        if (requestCode == FOLDER_SELECT_REQUEST) {
            if (resultCode != RESULT_OK || result == null || result.getData() == null) {
                notifyEvent("Folder selection cancelled."); return;
            }
            if (preparingFolder) return;
            preparingFolder = true;
            refresh();
            final android.net.Uri ownerPickedTree = result.getData();
            new Thread(() -> {
                try {
                    LanFolderExport.Packed folder = LanFolderExport.pack(
                            getApplicationContext(), ownerPickedTree);
                    main.post(() -> {
                        preparingFolder = false;
                        if (!visible || isFinishing()) {
                            Arrays.fill(folder.bytes, (byte) 0);
                            refresh(); return;
                        }
                        if (sharedFileBytes != null) Arrays.fill(sharedFileBytes, (byte) 0);
                        sharedFileBytes = folder.bytes;
                        sharedFileName = folder.name;
                        fileSelected.setText(folder.name + " · " + folder.fileCount + " files · "
                                + folder.bytes.length + " bytes");
                        notifyEvent("Folder packaged and staged. Start LAN sharing; each send still needs approval.");
                        refresh();
                    });
                } catch (Exception invalid) {
                    main.post(() -> {
                        preparingFolder = false;
                        notifyEvent("Folder refused: invalid paths, sensitive entries, empty folders or over 4 MiB.");
                        refresh();
                    });
                }
            }, "superagent-owner-selected-folder-pack").start();
            return;
        }
        if (requestCode != SCREEN_REQUEST) return;
        requestingCapture = false;
        if (resultCode != RESULT_OK || result == null || server == null
                || !RemoteControlPermit.hasApprovedSession()) {
            notifyEvent("Android screen capture declined or session ended.");
            refresh();
            return;
        }
        Intent start = new Intent(this, ScreenProjectionService.class)
                .setAction(ScreenProjectionService.ACTION_START)
                .putExtra(ScreenProjectionService.EXTRA_RESULT_CODE, resultCode)
                .putExtra(ScreenProjectionService.EXTRA_RESULT_DATA, result);
        startForegroundService(start);
        main.postDelayed(this::refresh, 800);
    }

    private void toggleRemoteInput() {
        if (RemoteControlPermit.canControl()) {
            RemoteControlPermit.inputConsent(false);
            notifyEvent("Remote touch disabled by phone owner.");
            refresh();
            return;
        }
        if (!visible || !RemoteControlPermit.canView() || !ControlledAccessibilityService.enabled()) {
            notifyEvent("An approved screen session and manually enabled Accessibility are required.");
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("ALLOW REMOTE TOUCH for this session?")
                .setMessage("Your paired controller can tap, swipe, use Home/Back and insert text into non-password editable fields. These actions may affect other apps. Only approve someone you trust. The STOP notification immediately revokes access.")
                .setNegativeButton("DENY", null)
                .setPositiveButton("ENABLE TOUCH", (d, w) -> {
                    RemoteControlPermit.inputConsent(true);
                    notifyEvent("Owner enabled remote touch for this session.");
                    refresh();
                }).show();
    }

    @Override protected void onStart() {
        super.onStart();
        currentActivity = new WeakReference<>(this);
        visible = true;
        refresh();
        main.postDelayed(this::connectPendingQrWhenForeground, 100);
    }
    @Override protected void onStop() {
        visible = false;
        if (!requestingCapture && !ScreenProjectionService.isActive()) stopSharing();
        super.onStop();
    }

    @Override protected void onDestroy() {
        if (currentActivity.get() == this) currentActivity.clear();
        stopSharing();
        super.onDestroy();
    }
}
