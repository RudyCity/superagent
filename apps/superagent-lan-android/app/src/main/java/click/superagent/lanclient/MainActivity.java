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
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.WindowManager;
import android.view.View;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ImageView;
import android.widget.EditText;
import android.text.InputFilter;
import android.text.InputType;
import android.widget.ScrollView;
import android.widget.TextView;

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
    // Direct LAN is Activity-owned; internet tunnel is ForegroundService-owned.
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
    private EditText tvCoreUrlInput;
    private ImageView tvQrPreview;
    private TextView tvQrStatus;
    private Button tvQrCreate, tvQrCancel;
    private volatile int tvQrGeneration;
    private String pendingQrPayload;
    private AndroidLocalTerminalUi terminalUi;

    private String appBuildLabel() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return "Version " + info.versionName + " · Build " + info.getLongVersionCode();
        } catch (PackageManager.NameNotFoundException ignored) {
            return "Version unavailable";
        }
    }

    static boolean hasVisibleOwner() {
        MainActivity owner = currentActivity.get();
        return owner != null && owner.visible && !owner.isFinishing();
    }

    static boolean requestTunnelApproval(String kind, String controller, String address, int seconds) {
        MainActivity owner = currentActivity.get();
        if (owner == null || !owner.visible || owner.isFinishing()) return false;
        return owner.requestApproval(kind, controller, address, seconds);
    }

    static void executeTunnelApprovedAction(String command, BooleanSupplier authorized) {
        MainActivity owner = currentActivity.get();
        if (owner != null && owner.visible && !owner.isFinishing())
            owner.executeApprovedAction(command, authorized);
    }

    static void tunnelNotice(String message) {
        MainActivity owner = currentActivity.get();
        if (owner == null) return;
        owner.main.post(() -> {
            if (!owner.visible || owner.isFinishing()) return;
            if (owner.qrScanStatus != null) owner.qrScanStatus.setText(message);
            owner.notifyEvent(message);
        });
    }

    private LanClientServer activeServer() {
        LanClientServer direct = server;
        return direct != null && direct.isRunning() ? direct : TunnelForegroundService.currentServer();
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

    private LinearLayout row(LinearLayout container, int topMargin) {
        LinearLayout row = AndroidUiKit.row(this);
        add(container, row, topMargin);
        return row;
    }

    private Button actionIn(LinearLayout row, String title, Runnable callback) {
        Button button = AndroidUiKit.button(this, title, callback);
        AndroidUiKit.addToRow(row, button, 1.0f);
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
        boolean tv = AndroidTvUi.isTv(this);
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
        LinearLayout terminalPage = AndroidUiKit.page(this);
        pageHost = new FrameLayout(this);
        pages = new ScrollView[] {
                AndroidUiKit.scroll(this, homePage),
                AndroidUiKit.scroll(this, connectPage),
                AndroidUiKit.scroll(this, controlPage),
                AndroidUiKit.scroll(this, filesPage),
                AndroidUiKit.scroll(this, terminalPage)
        };
        for (ScrollView page : pages) pageHost.addView(page);
        LinearLayout navigation = AndroidTvUi.navigation(this, tv);
        String[] labels = { "Home", "Connect", "Control", "Files", "Terminal" };
        tabButtons = new Button[labels.length];
        for (int i = 0; i < labels.length; i++) {
            final int destination = i;
            tabButtons[i] = AndroidUiKit.tab(this, labels[i], () -> showTab(destination));
            AndroidTvUi.addTab(this, navigation, tabButtons[i], tv);
        }
        AndroidTvUi.attach(this, shell, pageHost, navigation, tv);
        setContentView(shell);

        add(homePage, label("Dashboard", 26, AndroidUiKit.TEXT, true), 0);
        add(homePage, label("Active pairing, screen assistance, and local telemetry.", 13, AndroidUiKit.TEXT_MUTED, false), 2);
        add(connectPage, label("Device Pairing", 26, AndroidUiKit.TEXT, true), 0);
        add(connectPage, label("Pair via QR scan (recommended) or direct local Wi-Fi.", 13, AndroidUiKit.TEXT_MUTED, false), 2);
        add(controlPage, label("Screen & Touch", 26, AndroidUiKit.TEXT, true), 0);
        add(controlPage, label("Assisted screen mirroring and remote interaction.", 13, AndroidUiKit.TEXT_MUTED, false), 2);
        add(filesPage, label("Document Vault", 26, AndroidUiKit.TEXT, true), 0);
        add(filesPage, label("Encrypted peer-to-peer file transfer over local Wi-Fi.", 13, AndroidUiKit.TEXT_MUTED, false), 2);
        terminalUi = new AndroidLocalTerminalUi(this, terminalPage);

        LinearLayout layout = section(homePage, "SYSTEM STATUS");
        add(layout, label(appBuildLabel(), 11, AndroidUiKit.BLUE, false), 0);
        dashboardStatus = label("Ready to Connect", 22, AndroidUiKit.TEXT, true);
        add(layout, dashboardStatus, 4);
        dashboardConnection = label("Connect your phone to SuperAgent Tray on your PC to begin.", 13,
                AndroidUiKit.TEXT_MUTED, false);
        add(layout, dashboardConnection, 2);

        LinearLayout quickActionRow = row(layout, 12);
        Button connectShortcut = actionIn(quickActionRow, "Connect PC", () -> showTab(1));
        AndroidUiKit.primary(connectShortcut);
        dashboardStop = actionIn(quickActionRow, "Stop All", this::stopSharing);
        AndroidUiKit.destructive(dashboardStop);

        LinearLayout bentoModules = section(homePage, "COMPANION MODULES");
        add(bentoModules, label("Direct access to companion capabilities", 12, AndroidUiKit.TEXT_MUTED, false), 2);
        LinearLayout modRow1 = row(bentoModules, 10);
        actionIn(modRow1, "Screen Control", () -> showTab(2));
        actionIn(modRow1, "File Transfer", () -> showTab(3));
        LinearLayout modRow2 = row(bentoModules, 8);
        actionIn(modRow2, "Local Shell", () -> showTab(4));
        actionIn(modRow2, "System Settings", () -> startActivity(new Intent(Settings.ACTION_SETTINGS)));

        layout = section(homePage, "SECURITY & AUDIT LOG");
        events = label("Waiting for connection request. Zero cloud telemetry.", 12, AndroidUiKit.TEXT_MUTED, false);
        events.setTypeface(Typeface.MONOSPACE);
        events.setTextIsSelectable(true);
        events.setPadding(dp(12), dp(10), dp(12), dp(10));
        events.setBackground(AndroidUiKit.shape(AndroidUiKit.SURFACE_INSET, AndroidUiKit.LINE_SUBTLE, 12, this));
        add(layout, events, 6);
        add(layout, label("Every pairing and support session requires explicit on-phone approval.", 11, AndroidUiKit.TEXT_SUBTLE, false), 4);

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
        if (tv) segmentInput.setText("support-tv");
        LinearLayout tvPairingCard = section(connectPage, "DISPLAY PAIRING QR · ALL ANDROID");
            add(tvPairingCard, label("For a remote connection, display a QR from this device using a trusted HTTPS Core URL. Share a photo of the QR with your authorized controller.", 16, AndroidUiKit.ACCENT, true), 7);
            add(tvPairingCard, label("TRUSTED CORE HTTPS URL", 12, AndroidUiKit.MUTED, false), 3);
            tvCoreUrlInput = new EditText(this);
            tvCoreUrlInput.setSingleLine(true);
            tvCoreUrlInput.setHint("https://your-superagent-tunnel.example");
            tvCoreUrlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
            tvCoreUrlInput.setFilters(new InputFilter[]{new InputFilter.LengthFilter(240)});
            tvCoreUrlInput.setText(getPreferences(MODE_PRIVATE).getString("tvCoreOrigin", ""));
            AndroidUiKit.field(tvCoreUrlInput);
            add(tvPairingCard, tvCoreUrlInput, 6);
            tvQrCreate = action(tvPairingCard, "Show pairing QR", this::showTvQr);
            AndroidUiKit.primary(tvQrCreate);
            tvQrPreview = new ImageView(this);
            tvQrPreview.setAdjustViewBounds(true);
            tvQrPreview.setContentDescription("Camera-free device pairing QR, shown only during a pending request");
            tvQrPreview.setVisibility(View.GONE);
            add(tvPairingCard, tvQrPreview, 3);
            tvQrStatus = label("No pairing request. QR contains no device password or session token.", 13, AndroidUiKit.MUTED, false);
            add(tvPairingCard, tvQrStatus, 3);
            tvQrCancel = action(tvPairingCard, "Cancel QR pairing", this::cancelTvQr);
            tvQrCancel.setEnabled(false);

        layout = section(connectPage, "SHARING");
        LinearLayout sharingCard = layout;
        status = label("OFF · no access", 19, Color.WHITE, true);
        add(layout, status, 2);
        LinearLayout lanActionRow = row(layout, 10);
        start = actionIn(lanActionRow, "Start LAN", this::startSharing);
        AndroidUiKit.primary(start);
        stop = actionIn(lanActionRow, "Stop sharing", this::stopSharing);
        AndroidUiKit.destructive(stop);

        layout = section(connectPage, "DEVICE TUNNEL · QR CONNECT");
        LinearLayout connectQrCard = layout;
        add(layout, label("Scan the one-time QR shown in SuperAgent Tray. The phone enrolls and starts pairing automatically through outbound HTTPS; you only confirm the pairing approval on this phone.", 13, AndroidUiKit.MUTED, false), 2);
        tunnelScan = action(layout, "Scan QR & Connect", this::scanTunnelQr);
        AndroidUiKit.primary(tunnelScan);
        qrScanStatus = label("Ready to scan the Connection QR shown in SuperAgent Tray.", 12, AndroidUiKit.TEXT_MUTED, false);
        qrScanStatus.setPadding(dp(10), dp(8), dp(10), dp(8));
        qrScanStatus.setBackground(AndroidUiKit.shape(AndroidUiKit.SURFACE_INSET, AndroidUiKit.LINE_SUBTLE, 10, this));
        add(layout, qrScanStatus, 4);
        add(layout, label("Scan with this app, not your phone's regular camera. Secure TLS connection.", 11, AndroidUiKit.TEXT_SUBTLE, false), 4);
        tunnelState = label("Tunnel OFF", 13, AndroidUiKit.TEXT, true);
        add(layout, tunnelState, 6);
        LinearLayout tunnelActionRow = row(layout, 8);
        tunnelDisconnect = actionIn(tunnelActionRow, "Disconnect tunnel", this::disconnectTunnel);
        AndroidUiKit.destructive(tunnelDisconnect);
        manualSetupToggle = actionIn(tunnelActionRow, "Manual setup · Advanced", this::toggleManualSetup);

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
        if (tv) {
            tunnelScan.setVisibility(View.GONE);
            qrScanStatus.setText("On TV, use the LAN pairing code or enter a trusted tunnel invitation with your remote or Bluetooth keyboard.");
            manualSetupPanel.setVisibility(View.VISIBLE);
            manualSetupToggle.setText("Hide manual setup");
        }

        layout = section(connectPage, "VERIFICATION PIN & TLS");
        add(layout, label("One-time 8-digit pairing code (valid 2 minutes)", 12, AndroidUiKit.TEXT_MUTED, false), 0);
        LinearLayout pinBox = AndroidUiKit.insetBox(this, 4);
        code = label("- - - -", 26, AndroidUiKit.ACCENT, true);
        code.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        code.setGravity(Gravity.CENTER);
        code.setLetterSpacing(0.15f);
        pinBox.addView(code);
        add(layout, pinBox, 4);

        LinearLayout codeActionRow = row(layout, 8);
        renew = actionIn(codeActionRow, "Rotate PIN", () -> {
            LanClientServer live = activeServer();
            if (live != null) code.setText(live.rotateCode());
        });
        copy = actionIn(codeActionRow, "Copy Fingerprint", () -> {
            LanClientServer live = activeServer();
            if (live == null || live.currentInfo() == null) return;
            ClipboardManager mgr = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (mgr != null) mgr.setPrimaryClip(ClipData.newPlainText("Target certificate SHA-256", live.currentInfo().fingerprint));
            notifyEvent("Fingerprint copied. Compare all 64 digits on the controller.");
        });

        add(layout, label("Phone IP & Port:", 11, AndroidUiKit.TEXT_SUBTLE, false), 8);
        ip = label("Not connected", 13, AndroidUiKit.TEXT, true);
        add(layout, ip, 0);

        fingerprint = label("Fingerprint not generated", 11, AndroidUiKit.TEXT_MUTED, false);
        fingerprint.setTypeface(Typeface.MONOSPACE);
        fingerprint.setTextIsSelectable(true);
        fingerprint.setTextSize(10);
        add(layout, fingerprint, 2);

        layout = section(connectPage, "LOCAL APPROVAL");
        paired = label("No paired controllers", 14, AndroidUiKit.TEXT, true);
        add(layout, paired, 0);
        add(layout, label("Approve pairing and every support session. Every additional Android action requires its own on-screen approval. Only you can change system settings.", 12, AndroidUiKit.TEXT_MUTED, false), 4);
        LinearLayout securityRow = row(layout, 8);
        revoke = actionIn(securityRow, "Revoke Access", () -> {
            LanClientServer live = activeServer();
            if (live != null) {
                live.revoke();
                code.setText(live.rotateCode());
                refresh();
            }
        });
        AndroidUiKit.destructive(revoke);
        actionIn(securityRow, "System Settings", () -> {
            stopSharing();
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        });

        layout = section(controlPage, "SCREEN CONTROL · OPT IN");
        add(layout, label("Android will ask before sharing your screen. Remote taps are optional and require separate Accessibility and on-phone consent.", 13, AndroidUiKit.MUTED, false), 5);
        screenState = label("Screen OFF · Remote touch OFF", 15, Color.WHITE, true);
        add(layout, screenState, 4);
        action(layout, "Request Accessibility setup", this::requestAccessibilitySetup);
        LinearLayout screenActionRow = row(layout, 8);
        startScreen = actionIn(screenActionRow, "Share screen", this::beginScreenConsent);
        AndroidUiKit.primary(startScreen);
        stopScreen = actionIn(screenActionRow, "Stop screen & revoke", this::stopSharing);
        AndroidUiKit.destructive(stopScreen);
        touchToggle = action(layout, "Allow remote taps and swipes", this::toggleRemoteInput);
        add(layout, label("Remote interaction can affect other apps. Do not open passwords or financial data. Secure screens may block capture. STOP is available in Android notifications.", 12, AndroidUiKit.MUTED, false), 6);
        layout = section(filesPage, "SEND FILES · OWNER APPROVAL");
        add(layout, label("Send a selected Android document to Windows or receive into Downloads/SuperAgent LAN. 4 MiB maximum per file. Each transfer needs an on-phone APPROVE.", 13, AndroidUiKit.MUTED, false), 6);
        LinearLayout filePreviewBox = AndroidUiKit.insetBox(this, 4);
        fileSelected = label("No document selected", 13, AndroidUiKit.TEXT, true);
        fileSelected.setGravity(Gravity.CENTER);
        filePreviewBox.addView(fileSelected);
        add(layout, filePreviewBox, 4);
        LinearLayout fileSelectRow = row(layout, 8);
        actionIn(fileSelectRow, "Select File", () -> {
            stopSharing();
            Intent chooser = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            startActivityForResult(chooser, FILE_SELECT_REQUEST);
        });
        actionIn(fileSelectRow, "Select Folder", () -> {
            stopSharing();
            Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(picker, FOLDER_SELECT_REQUEST);
        });
        add(layout, label("Transfers are encrypted and verified over local Wi-Fi. Unsafe files are refused.", 11, AndroidUiKit.TEXT_SUBTLE, false), 4);
        action(layout, "Clear Selected Document", () -> {
            if (sharedFileBytes != null) Arrays.fill(sharedFileBytes, (byte) 0);
            sharedFileBytes = null; sharedFileName = null;
            fileSelected.setText("No document selected");
            stopSharing();
        });
        if (tv) {
            connectPage.removeView(tvPairingCard);
            connectPage.addView(tvPairingCard, 2);
            connectPage.removeView(sharingCard);
            connectPage.addView(sharingCard, 3);
        } else {
            connectPage.removeView(connectQrCard);
            connectPage.addView(connectQrCard, 2);
            connectPage.removeView(tvPairingCard);
            connectPage.addView(tvPairingCard, 3);
            connectPage.removeView(sharingCard);
            connectPage.addView(sharingCard, 3);
        }
        // Keep direct pairing prominent on TV and QR-first pairing on phones.
        showTab(state == null ? 0 : Math.max(0, Math.min(4, state.getInt("selectedTab", 0))));
        if (tv) tabButtons[0].requestFocus();
        refresh();
    }

    private void refresh() {
        LanClientServer live = activeServer();
        boolean on = live != null && live.isRunning();
        boolean tunnelOn = TunnelForegroundService.isActive();
        if (start != null) start.setEnabled(!on && !launching && !preparingFolder);
        if (segmentInput != null) segmentInput.setEnabled(!on && !launching);
        if (stop != null) stop.setEnabled(on);
        if (dashboardStop != null) dashboardStop.setEnabled(on || ScreenProjectionService.isActive());
        if (renew != null) renew.setEnabled(on);
        if (revoke != null) revoke.setEnabled(on);
        if (copy != null) copy.setEnabled(on);
        if (tunnelSetupInput != null) tunnelSetupInput.setEnabled(!tunnelOn && !launching);
        if (tunnelScan != null) tunnelScan.setEnabled(!tunnelOn && !launching && !preparingFolder && !qrScanInProgress);
        if (tunnelConnect != null) tunnelConnect.setEnabled(!tunnelOn && !launching);
        if (tunnelDisconnect != null) tunnelDisconnect.setEnabled(tunnelOn);
        if (tunnelState != null) tunnelState.setText(tunnelOn
                ? TunnelForegroundService.currentStatus() : "Tunnel OFF · " + TunnelForegroundService.currentStatus());
        if (status != null && server == null)
            status.setText(tunnelOn ? "ON · secure HTTPS tunnel" : "OFF · no access");
        if (tunnelOn && live != null && live.currentInfo() != null) {
            LanClientServer.Info tunnelInfo = live.currentInfo();
            if (ip != null) ip.setText("Local TLS " + tunnelInfo.ip + ":" + tunnelInfo.port);
            if (code != null) code.setText("AUTO · QR pairing");
            if (fingerprint != null) fingerprint.setText(tunnelInfo.fingerprint);
        }
        if (paired != null) paired.setText(on ? live.state() : "No paired controllers");
        if (dashboardStatus != null) {
            dashboardStatus.setText(tunnelOn ? "Secure tunnel running"
                    : on ? "LAN sharing is active" : "Device is offline");
            dashboardStatus.setTextColor(tunnelOn || on ? AndroidUiKit.ACCENT : AndroidUiKit.TEXT);
        }
        if (dashboardConnection != null) {
            dashboardConnection.setText(tunnelOn
                    ? (RemoteControlPermit.hasApprovedSession() ? "Support session approved · Owner controls remain active"
                        : TunnelForegroundService.currentStatus())
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
        if (server != null || TunnelForegroundService.isActive() || launching || preparingFolder) return;
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

    private void cancelTvQr() {
        tvQrGeneration++;
        if (tvQrPreview != null) {
            tvQrPreview.setImageDrawable(null);
            tvQrPreview.setVisibility(View.GONE);
        }
        if (tvQrStatus != null) tvQrStatus.setText("TV pairing cancelled. Create a new QR when ready.");
        if (tvQrCreate != null) tvQrCreate.setEnabled(true);
        if (tvQrCancel != null) tvQrCancel.setEnabled(false);
        if (server == null && !TunnelForegroundService.isActive())
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void showTvQr() {
        if (tvCoreUrlInput == null || !visible
                || launching || preparingFolder || TunnelForegroundService.isActive()
                || server != null) {
            if (tvQrStatus != null) tvQrStatus.setText("Stop current sharing before starting TV QR pairing.");
            return;
        }
        if (!notificationsReady()) {
            requestNotificationSetup();
            return;
        }
        final String origin;
        try {
            origin = AndroidTvQrPairing.requireHttpsOrigin(tvCoreUrlInput.getText().toString().trim());
        } catch (Exception invalid) {
            tvCoreUrlInput.setError(invalid.getMessage());
            return;
        }
        final int generation = ++tvQrGeneration;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        tvQrCreate.setEnabled(false);
        tvQrCancel.setEnabled(true);
        tvQrStatus.setText("Requesting a temporary QR from the trusted HTTPS Core...");
        new Thread(() -> {
            try {
                AndroidTvQrPairing.Ticket ticket = AndroidTvQrPairing.create(
                        origin, ("Android " + Build.MODEL).replaceAll("[^A-Za-z0-9_ .-]", "").trim());
                Bitmap bitmap = AndroidTvQrPairing.bitmap(ticket.publicQr(), 440);
                main.post(() -> {
                    if (generation != tvQrGeneration || !visible) return;
                    getPreferences(MODE_PRIVATE).edit().putString("tvCoreOrigin", origin).apply();
                    tvQrPreview.setImageBitmap(bitmap);
                    tvQrPreview.setVisibility(View.VISIBLE);
                    tvQrStatus.setText("Take a photo and send it to your SuperAgent controller. "
                            + "The controller approves this exact TV challenge. Expires in 3 minutes."
                            + "\nRequest ID: " + ticket.id
                            + "\nChallenge: " + ticket.challenge
                            + "\nNo private token is displayed.");
                });
                while (generation == tvQrGeneration && System.currentTimeMillis() < ticket.expiresAt) {
                    if (!visible) break;
                    JSONObject reply = AndroidTvQrPairing.poll(ticket);
                    if ("approved".equals(reply.optString("state"))) {
                        final String setup = AndroidTvQrPairing.validatedSetup(ticket, reply);
                        main.post(() -> {
                            if (generation != tvQrGeneration || !visible) return;
                            tvQrGeneration++;
                            tvQrPreview.setImageDrawable(null);
                            tvQrPreview.setVisibility(View.GONE);
                            tvQrCreate.setEnabled(true);
                            tvQrCancel.setEnabled(false);
                            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                            tvQrStatus.setText("Your controller approved the QR. Confirm on this device to enroll.");
                            new AlertDialog.Builder(this)
                                    .setTitle("Connect this Android device?")
                                    .setMessage("A privileged controller approved your temporary QR. "
                                            + "Start an outbound secure HTTPS tunnel to " + ticket.url
                                            + "? You must separately approve device pairing, support sessions "
                                            + "and any future remote input on this device.")
                                    .setNegativeButton("DENY", (dialog, which) ->
                                            tvQrStatus.setText("TV owner denied the connection."))
                                    .setPositiveButton("CONNECT", (dialog, which) ->
                                            connectTunnelSetup(setup, null))
                                    .show();
                        });
                        return;
                    }
                    Thread.sleep(2500);
                }
                main.post(() -> {
                    if (generation == tvQrGeneration) {
                        cancelTvQr();
                        tvQrStatus.setText("TV QR expired or app left the foreground. Create a new QR.");
                    }
                });
            } catch (Exception error) {
                main.post(() -> {
                    if (generation == tvQrGeneration) {
                        cancelTvQr();
                        tvQrStatus.setText("Cannot show TV pairing QR: "
                                + error.getClass().getSimpleName() + " · " + error.getMessage());
                    }
                });
            }
        }, "superagent-tv-qr-bootstrap").start();
    }

    private void scanTunnelQr() {
        if (qrScanInProgress) return;
        if (TunnelForegroundService.isActive()) {
            qrFeedback("Device Tunnel is already running. Disconnect before scanning another QR.");
            return;
        }
        qrScanInProgress = true;
        refresh();
        AndroidQrScanner.scan(this, raw -> {
            if (raw == null || raw.isEmpty() || raw.length() > 2048)
                qrFeedback("QR rejected. Scan a fresh Connect QR from SuperAgent Tray.");
            else if (!AndroidQrScanner.isConnectPayload(raw))
                qrFeedback(raw.startsWith("https://") ? "Use Create connect QR, not APK download QR."
                        : "Wrong QR format. Choose Create connect QR in Tray.");
            else {
                pendingQrPayload = raw;
                qrFeedback("QR detected. Returning to SuperAgent to connect...");
                main.postDelayed(this::connectPendingQrWhenForeground, 700);
            }
        }, this::qrFeedback, () -> { qrScanInProgress = false; refresh(); });
    }

    private void connectTunnelFromQr(String setup) {
        if (!visible || isFinishing()) {
            pendingQrPayload = setup;
            return;
        }
        if (launching || preparingFolder) {
            qrFeedback("Device sharing is still starting; scan again after it is ready.");
            return;
        }
        // QR uses a foreground-owned loopback TLS engine, not the Wi-Fi LAN listener.
        connectTunnelSetup(setup, null);
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
        if (TunnelForegroundService.isActive()) {
            qrFeedback("Disconnect the existing tunnel before scanning a new QR.");
            return;
        }
        if (!notificationsReady()) {
            qrFeedback("Enable SuperAgent notifications to show the persistent STOP SHARING control.");
            requestNotificationSetup();
            return;
        }
        try {
            stopDirectSharing();
            TunnelForegroundService.requestStart(this, setup, sharedFileName, sharedFileBytes);
            if (tunnelSetupInput != null) tunnelSetupInput.setText("");
            qrFeedback("Starting secure outbound HTTPS tunnel (works over mobile data)...");
            refresh();
        } catch (RuntimeException error) {
            qrFeedback("Cannot connect tunnel: " + error.getMessage());
            refresh();
        }
    }

    private void disconnectTunnel() {
        TunnelForegroundService.requestStop(this);
        notifyEvent("Device Tunnel disconnected by phone owner.");
        refresh();
    }

    private void stopDirectSharing() {
        LanClientServer old = server;
        server = null;
        if (old != null) old.close();
        if (approvalDialog != null) approvalDialog.dismiss();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void stopSharing() {
        if (tvQrCreate != null && !tvQrCreate.isEnabled()) cancelTvQr();
        TunnelForegroundService.requestStop(this);
        stopDirectSharing();
        RemoteControlPermit.revoke();
        ScreenProjectionService.stop(this);
        if (status != null) status.setText("OFF — no access");
        if (ip != null) ip.setText("Not connected");
        if (code != null) code.setText("—");
        if (fingerprint != null) fingerprint.setText("Not generated");
        refresh();
    }

    private void executeApprovedAction(String command, BooleanSupplier stillAuthorized) {
        // Give TLS acknowledgement time to flush before leaving the foreground.
        main.postDelayed(() -> {
            LanClientServer live = activeServer();
            if (!visible || live == null || !live.isRunning()
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
        if (terminalUi != null) terminalUi.stopRunningCommand();
        CountDownLatch latch = new CountDownLatch(1);
        AtomicBoolean allowed = new AtomicBoolean(false);
        main.post(() -> {
            if (!visible || isFinishing()) { latch.countDown(); return; }
            approvalDialog = new AlertDialog.Builder(this)
                    .setTitle(kind.startsWith("shell:") ? "Approve agent Android terminal command?"
                            : kind.startsWith("file:") ? "Approve file transfer?"
                            : kind.startsWith("action:") ? "Approve Android support action?"
                            : kind.equals("pair") ? "Approve controller pairing?" : "Approve support session?")
                    .setMessage("Controller: " + controller + "\nLocal IP: " + address
                            + (kind.startsWith("shell:")
                              ? String.valueOf((char)10) + String.valueOf((char)10)
                                + "Agent command (Android app sandbox only):" + String.valueOf((char)10)
                                + kind.substring(6)
                                + String.valueOf((char)10) + String.valueOf((char)10)
                                + "Runs for up to 10 seconds. This command executes only if you approve here. Never approve unfamiliar commands."
                              : kind.startsWith("file:")
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
            if (owner.activeServer() != null) owner.stopSharing();
            owner.refresh();
        });
    }

    private void beginScreenConsent() {
        LanClientServer live = activeServer();
        if (!visible || live == null || !live.isRunning()
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
        if (terminalUi != null) terminalUi.stopRunningCommand();
        LanClientServer target = activeServer();
        if (target != null) target.stopRemoteShell();
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
        if (resultCode != RESULT_OK || result == null || activeServer() == null
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
        if (tvQrCreate != null && !tvQrCreate.isEnabled()) cancelTvQr();
        if (terminalUi != null) terminalUi.stopRunningCommand();
        LanClientServer target = activeServer();
        if (target != null) target.stopRemoteShell();
        // Direct LAN is screen-bound; the foreground HTTPS service owns its
        // own loopback listener and survives normal Activity backgrounding.
        if (!requestingCapture && !ScreenProjectionService.isActive()) stopDirectSharing();
        super.onStop();
    }
    @Override public void onBackPressed() {
        if (AndroidTvUi.isTv(this) && selectedTab != 0) showTab(0);
        else super.onBackPressed();
    }
    @Override protected void onDestroy() {
        if (currentActivity.get() == this) currentActivity.clear();
        if (terminalUi != null) terminalUi.close();
        stopDirectSharing();
        super.onDestroy();
    }
}
