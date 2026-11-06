package click.superagent.lanclient;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.SystemClock;

import org.json.JSONObject;
import org.json.JSONException;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;

/**
 * Android implementation of the existing SuperAgent LAN Client v1 wire protocol.
 *
 * Intentional scope:
 * - Only a physically selected Android Wi-Fi/Ethernet private IPv4 LAN.
 * - TLS 1.3 certificate pin verified on the controller before code submission.
 * - One-time 8 digit code / 120 seconds / 5 attempts + on-device consent.
 * - Explicit per-session consent; tokens expire on stop, idle, or absolute timeout.
 * - At most one session, diagnostic allowlist and separately owner-approved
 *   local Settings handoffs / one-step media volume actions; no general shell.
 * - No remote control while the Activity is hidden (MainActivity closes this server).
 */
public final class LanClientServer implements AutoCloseable {
    public static final int PORT = 17845;
    private static final int MAX_REQUEST_BYTES = 8192;
    private static final long PAIR_MS = 120_000;
    private static final long SESSION_IDLE_MS = 600_000;
    private static final long SESSION_MAX_MS = 3_600_000;

    public interface Approval {
        boolean ask(String kind, String controller, String remoteIp, int timeoutSeconds);
    }
    public interface Notice {
        void show(String text);
    }

    /** Runs only in the visible Android Activity after a separate owner approval. */
    public interface ApprovedAction {
        void launch(String allowlistedAction, BooleanSupplier stillAuthorized);
    }

    public static final class Info {
        public final String ip;
        public final int port;
        public final String code;
        public final String fingerprint;
        public final String transport;
        Info(String ip, int port, String code, String fingerprint, String transport) {
            this.ip = ip; this.port = port; this.code = code;
            this.fingerprint = fingerprint; this.transport = transport;
        }
    }

    private static final class Paired {
        final String id, secret, ip, label;
        Paired(String id, String secret, String ip, String label) {
            this.id = id; this.secret = secret; this.ip = ip; this.label = label;
        }
    }
    private static final class Session {
        final String id, secret, pairId, ip;
        final long created;
        long lastUsed;
        Session(String id, String secret, String pairId, String ip, long now) {
            this.id = id; this.secret = secret; this.pairId = pairId;
            this.ip = ip; this.created = now; this.lastUsed = now;
        }
    }

    private final Object guard = new Object();
    private final SecureRandom random = new SecureRandom();
    private final LanFileExchange fileExchange;
    private final Context context;
    private final Approval approval;
    private final Notice notice;
    private final ApprovedAction approvedAction;
    private final Map<String, Paired> paired = new HashMap<>();
    private final Set<SSLSocket> sockets = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile SSLServerSocket tlsListener;
    private volatile DatagramSocket udpListener;
    private volatile WifiManager.MulticastLock multicastLock;
    private volatile Thread acceptThread, udpThread;
    private volatile ThreadPoolExecutor pool;
    private volatile LanNetwork.Link link;
    private volatile Info info;
    private volatile String segmentTag;
    private Session session;
    private String code;
    private long expires;
    private int attempts;
    private boolean busy;

    public LanClientServer(Context context, Approval approval, Notice notice,
                           ApprovedAction approvedAction) {
        this.context = context.getApplicationContext();
        this.fileExchange = new LanFileExchange(this.context);
        this.approval = approval;
        this.notice = notice;
        this.approvedAction = approvedAction;
    }

    /**
     * Discovery grouping only; never replaces pinned TLS, one-time pairing
     * code or physical owner consent. Must be supplied before listener binds.
     */
    public static String normalizeSegmentName(String input) {
        if (input == null) throw new IllegalArgumentException("Network segment is required.");
        String normalized = input.trim().toLowerCase(Locale.ROOT);
        if (!normalized.matches("[a-z0-9 _.-]{3,32}"))
            throw new IllegalArgumentException("Segment must be 3-32 ASCII letters, digits, spaces, _, ., or -.");
        return normalized;
    }

    private static String segmentTagOf(String normalized) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(
                ("superagent-lan-segment-v1:" + normalized).getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(64);
        for (byte b : hash) hex.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        return hex.toString();
    }

    public Info start(String segmentName) throws Exception {
        String normalized = normalizeSegmentName(segmentName);
        String requiredTag = segmentTagOf(normalized);
        if (!running.compareAndSet(false, true)) throw new IllegalStateException("Client already running.");
        segmentTag = requiredTag;
        try {
            link = LanNetwork.current(context);
            if (link == null) {
                throw new IllegalStateException("Connect to a private Wi-Fi or Ethernet LAN (no VPN/cellular) first.");
            }
            LanIdentity.ServerIdentity identity = LanIdentity.getOrCreate();
            SSLServerSocket listener = (SSLServerSocket) identity.tls.getServerSocketFactory()
                    .createServerSocket();
            listener.setEnabledProtocols(new String[] {"TLSv1.3"});
            listener.setNeedClientAuth(false); // Pair code and pinned key authorize controller.
            listener.setReuseAddress(false);
            listener.bind(new InetSocketAddress(InetAddress.getByName(link.ip), PORT), 8);
            tlsListener = listener;

            synchronized (guard) { nextCode(); }
            info = new Info(link.ip, PORT, code, identity.fingerprint, link.transport);
            pool = new ThreadPoolExecutor(2, 4, 30, TimeUnit.SECONDS,
                    new ArrayBlockingQueue<>(8), new ThreadPoolExecutor.AbortPolicy());
            acquireMulticastLock();

            acceptThread = new Thread(this::acceptLoop, "superagent-android-lan-tls");
            acceptThread.setDaemon(true);
            acceptThread.start();
            udpThread = new Thread(this::discoveryLoop, "superagent-android-lan-discovery");
            udpThread.setDaemon(true);
            udpThread.start();
            notice.show("LAN sharing on " + link.transport + " (" + link.ip + ").");
            return info;
        } catch (Exception e) {
            close();
            throw e;
        }
    }

    public void selectLocalFile(String name, byte[] bytes) {
        fileExchange.select(name, bytes);
    }
    public String sharedFileLabel() { return fileExchange.selectedLabel(); }
    public Info currentInfo() { return info; }
    public boolean isRunning() { return running.get(); }

    public String rotateCode() {
        if (!running.get()) throw new IllegalStateException("Start LAN sharing first.");
        synchronized (guard) {
            nextCode();
            notice.show("Pairing code rotated. Previous code invalidated.");
            return code;
        }
    }

    private void nextCode() {
        code = String.format(Locale.US, "%08d", random.nextInt(100_000_000));
        expires = SystemClock.elapsedRealtime() + PAIR_MS;
        attempts = 0;
    }

    public String state() {
        synchronized (guard) {
            return paired.size() + " paired controller(s) · " + (session == null ? "no session" : "session active");
        }
    }

    public void revoke() {
        fileExchange.clear();
        RemoteControlPermit.revoke();
        ScreenProjectionService.stop(context);
        synchronized (guard) {
            paired.clear();
            session = null;
            busy = false;
            if (running.get()) nextCode();
        }
        // Close in-progress commands and approval socket requests; no authorized
        // command is permitted after this action.
        for (SSLSocket socket : sockets) closeQuietly(socket);
        notice.show("All paired controllers and sessions revoked.");
    }

    private void acquireMulticastLock() {
        try {
            WifiManager wifi = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifi != null && "Wi-Fi".equals(link.transport)) {
                WifiManager.MulticastLock lock = wifi.createMulticastLock("superagent-lan-discovery");
                lock.setReferenceCounted(false);
                lock.acquire();
                multicastLock = lock;
            }
        } catch (Exception ignored) {
            notice.show("Wi-Fi discovery may be unavailable. Manual IPv4 pairing still works.");
        }
    }

    private void acceptLoop() {
        while (running.get()) {
            try {
                SSLServerSocket listener = tlsListener;
                if (listener == null) return;
                SSLSocket socket = (SSLSocket) listener.accept();
                if (!running.get()) { closeQuietly(socket); return; }
                if (!LanNetwork.permitsPeer(context, link, socket.getInetAddress().getHostAddress())
                        || !link.ip.equals(socket.getLocalAddress().getHostAddress())) {
                    closeQuietly(socket);
                    continue;
                }
                try {
                    pool.execute(() -> serve(socket));
                } catch (java.util.concurrent.RejectedExecutionException reject) {
                    closeQuietly(socket); // Bounded queue; never exhaust memory.
                }
            } catch (Exception error) {
                if (running.get()) notice.show("LAN TCP listener error: " + error.getClass().getSimpleName());
            }
        }
    }

    private void discoveryLoop() {
        DatagramSocket datagram = null;
        try {
            datagram = new DatagramSocket(null);
            datagram.setReuseAddress(false);
            // Broadcast datagrams address the subnet broadcast, not the host IP.
            // Accept on wildcard only for this UDP discovery port; verify peer
            // address and active physical link before every reply.
            datagram.bind(new InetSocketAddress(PORT + 1));
            datagram.setSoTimeout(2000);
            udpListener = datagram;
            byte[] buffer = new byte[100];
            while (running.get()) {
                try {
                    DatagramPacket incoming = new DatagramPacket(buffer, buffer.length);
                    datagram.receive(incoming);
                    if (!LanNetwork.permitsPeer(context, link, incoming.getAddress().getHostAddress())) continue;
                    String message = new String(incoming.getData(), incoming.getOffset(),
                            incoming.getLength(), StandardCharsets.US_ASCII);
                    if (!("SUPERAGENT_LAN_DISCOVER_2:" + segmentTag).equals(message)) continue;
                    JSONObject response = new JSONObject()
                            .put("version", 2)
                            .put("segmentTag", segmentTag)
                            .put("address", link.ip)
                            .put("port", PORT)
                            .put("name", "Android " + Build.MODEL)
                            .put("platform", "android")
                            .put("fingerprint", info.fingerprint);
                    byte[] reply = response.toString().getBytes(StandardCharsets.UTF_8);
                    datagram.send(new DatagramPacket(reply, reply.length,
                            incoming.getAddress(), incoming.getPort()));
                } catch (java.net.SocketTimeoutException ignored) {
                    // Re-evaluate running state without blocking indefinitely.
                } catch (Exception error) {
                    if (running.get()) notice.show("LAN discovery error: " + error.getClass().getSimpleName());
                }
            }
        } catch (Exception error) {
            if (running.get()) notice.show("LAN discovery unavailable; manually enter IPv4.");
        } finally {
            if (datagram != null) datagram.close();
        }
    }

    private void serve(SSLSocket socket) {
        sockets.add(socket);
        try (SSLSocket peer = socket) {
            peer.setEnabledProtocols(new String[] {"TLSv1.3"});
            peer.setSoTimeout(150_000);
            peer.startHandshake();
            String ip = peer.getInetAddress().getHostAddress();
            if (!running.get() || !LanNetwork.permitsPeer(context, link, ip)) return;
            String raw = readBoundedLine(peer.getInputStream());
            JSONObject request = new JSONObject(raw);
            handle(peer, request, ip);
        } catch (Exception ignored) {
            // Connection lost or malformed; never log arbitrary network payloads.
        } finally {
            sockets.remove(socket);
        }
    }

    private static String readBoundedLine(InputStream input) throws Exception {
        ByteArrayOutputStream data = new ByteArrayOutputStream(256);
        while (data.size() <= MAX_REQUEST_BYTES) {
            int b = input.read();
            if (b < 0) throw new IllegalArgumentException("Incomplete request.");
            if (b == '\n') return data.toString(StandardCharsets.UTF_8.name());
            data.write(b);
        }
        throw new IllegalArgumentException("LAN request oversized.");
    }

    private void handle(SSLSocket socket, JSONObject request, String ip) throws Exception {
        String op = request.optString("op", "");
        if ("pair".equals(op)) { handlePair(socket, request, ip); return; }

        Paired owner;
        String suppliedId = request.optString("pairId", "");
        synchronized (guard) { owner = paired.get(suppliedId); }
        if (owner == null || !owner.ip.equals(ip)
                || !secureEquals(owner.secret, request.optString("pairToken", ""))) {
            fail(socket, "Controller not paired."); return;
        }
        if ("open".equals(op)) { handleOpen(socket, owner, ip); return; }
        if ("revoke".equals(op)) {
            // Acknowledge authenticated remote revocation BEFORE closing sockets.
            // Keep the controller's current socket alive until the receipt is sent.
            synchronized (guard) {
                paired.clear(); session = null; busy = false; nextCode();
                fileExchange.clear();
                RemoteControlPermit.revoke();
            }
            send(socket, new JSONObject().put("ok", true));
            // Allow TLS acknowledgement to flush before screen service shuts down.
            new android.os.Handler(android.os.Looper.getMainLooper())
                    .postDelayed(() -> ScreenProjectionService.stop(context), 200);
            for (SSLSocket other : sockets) {
                if (other != socket) closeQuietly(other);
            }
            notice.show("All paired controllers and sessions revoked.");
            return;
        }

        Session active;
        synchronized (guard) {
            active = session;
            long now = SystemClock.elapsedRealtime();
            if (active != null && (now - active.lastUsed > SESSION_IDLE_MS
                    || now - active.created > SESSION_MAX_MS)) {
                active = null;
                session = null;
                fileExchange.clear();
                RemoteControlPermit.session(false);
                ScreenProjectionService.stop(context);
            }
            if (active != null && owner.id.equals(active.pairId) && active.ip.equals(ip)
                    && active.id.equals(request.optString("sessionId", ""))
                    && secureEquals(active.secret, request.optString("sessionToken", ""))) {
                active.lastUsed = now;
            } else {
                active = null;
            }
        }
        if (active == null) { fail(socket, "Session expired or denied."); return; }
        if ("close".equals(op)) {
            synchronized (guard) { session = null; fileExchange.clear(); }
            RemoteControlPermit.session(false);
            send(socket, new JSONObject().put("ok", true));
            ScreenProjectionService.stop(context);
            notice.show("Support session closed.");
            return;
        }
        if ("file_offer".equals(op)) {
            String direction = request.optString("direction", "");
            if (!"upload".equals(direction) && !"download".equals(direction)) {
                fail(socket, "Invalid file transfer direction."); return;
            }
            String filename = request.optString("name", "");
            int size = request.optInt("size", -1);
            String declaredName;
            try { declaredName = fileExchange.offeredName(direction, filename, size); }
            catch (Exception invalid) { fail(socket, "No owner-selected file or invalid upload metadata."); return; }
            String description = ("upload".equals(direction) ? "Receive " : "Send ")
                    + declaredName + " (" + ("download".equals(direction)
                        ? fileExchange.selectedLabel() : String.valueOf(size) + " bytes") + ")";
            if (!approval.ask("file:" + description, owner.label, ip, 90)
                    || !isStillAuthorized(active, owner, ip) || socket.isClosed()) {
                fail(socket, "File transfer not approved on Android."); return;
            }
            try {
                JSONObject offer = fileExchange.offer(direction, filename, size,
                        request.optString("sha256", ""));
                send(socket, offer);
                notice.show("Approved " + direction + " file: " + declaredName);
            } catch (Exception invalid) {
                fail(socket, "Another transfer active or invalid file metadata.");
            }
            return;
        }
        if ("file_put".equals(op) || "file_get".equals(op)
                || "file_finish".equals(op) || "file_abort".equals(op)) {
            String transferId = request.optString("transferId", "");
            try {
                JSONObject response;
                if ("file_put".equals(op)) {
                    response = fileExchange.put(transferId, request.optInt("seq", -1),
                            request.optString("data", ""));
                } else if ("file_get".equals(op)) {
                    response = fileExchange.get(transferId, request.optInt("seq", -1));
                } else if ("file_finish".equals(op)) {
                    response = fileExchange.finish(transferId);
                    notice.show("File transfer completed; checksum verified.");
                } else {
                    response = fileExchange.abort(transferId);
                }
                if (!isStillAuthorized(active, owner, ip)) {
                    fail(socket, "LAN session expired during file transfer."); return;
                }
                send(socket, response);
            } catch (Exception denied) {
                fail(socket, "File transfer rejected: sequence, size, expiry or hash invalid.");
            }
            return;
        }
        if ("schema".equals(op)) {
            // Metadata only; no screenshot decode, OCR, text content or media capture.
            Object previous = request.opt("knownRevision");
            if (!(previous instanceof Number)) {
                fail(socket, "Expected numeric schema revision."); return;
            }
            long known = ((Number) previous).longValue();
            if (known < 0 || known > 1_000_000_000L || ((Number) previous).doubleValue() != known) {
                fail(socket, "Schema revision invalid."); return;
            }
            try {
                JSONObject structure = ControlledAccessibilityService.schema(known);
                send(socket, new JSONObject().put("event", "schema").put("schema", structure));
                send(socket, new JSONObject().put("event", "done").put("ok", true));
            } catch (Exception unavailable) {
                fail(socket, "UI schema unavailable; check capture and Accessibility permissions.");
            }
            return;
        }
        if ("element".equals(op)) {
            // Semantic action is tightly coupled to the exact, current
            // snapshot. No general text/intent accessibility API exposed.
            if (!"click".equals(request.optString("kind", ""))) {
                fail(socket, "Unsupported semantic action."); return;
            }
            Object providedRevision = request.opt("revision");
            if (!(providedRevision instanceof Number)
                    || ((Number) providedRevision).doubleValue() != ((Number) providedRevision).longValue()) {
                fail(socket, "Semantic revision must be an integer."); return;
            }
            try {
                long revision = ((Number) providedRevision).longValue();
                String elementId = request.optString("elementId", "");
                boolean accepted = ControlledAccessibilityService.clickElement(revision, elementId);
                send(socket, new JSONObject().put("ok", accepted).put("accepted", accepted)
                        .put("kind", "click"));
            } catch (Exception staleOrDenied) {
                fail(socket, "Stale or unauthorized UI element. Refresh the schema.");
            }
            return;
        }
        if ("screen".equals(op)) {
            if (!RemoteControlPermit.canView()) {
                fail(socket, "Screen capture must be enabled by the phone owner.");
                return;
            }
            try {
                ScreenProjectionService.Frame frame = ScreenProjectionService.frame();
                send(socket, new JSONObject().put("event", "frame")
                        .put("mime", "image/jpeg")
                        .put("width", frame.width).put("height", frame.height)
                        .put("data", frame.jpeg));
                send(socket, new JSONObject().put("event", "done").put("ok", true));
            } catch (Exception unavailable) {
                fail(socket, "Fresh approved screenshot not available.");
            }
            return;
        }
        if ("input".equals(op)) {
            handleRemoteInput(socket, request);
            return;
        }
        if (!"exec".equals(op)) { fail(socket, "Unknown operation."); return; }
        String command = request.optString("command", "");
        if (command.length() < 1 || command.length() > 2000) {
            fail(socket, "Command length invalid."); return;
        }
        synchronized (guard) {
            if (busy || session != active) {
                fail(socket, "Another command is running or session closed."); return;
            }
            busy = true;
        }
        try {
            if (AndroidSupportActions.allowed(command)) {
                // Explicit on-device approval is REQUIRED for every action, even
                // when the support session itself has already been approved.
                // No dynamic intent, shell or configurable package target.
                if (!approval.ask("action:" + command, owner.label, ip, 90)
                        || !isStillAuthorized(active, owner, ip) || socket.isClosed()) {
                    fail(socket, "Android action not approved or session expired.");
                    return;
                }
                String message = AndroidSupportActions.description(command)
                        + " approved by the phone owner. Completing on the phone.";
                send(socket, new JSONObject()
                        .put("event", "output").put("stream", "stdout")
                        .put("data", message + "\n"));
                send(socket, new JSONObject()
                        .put("event", "done").put("ok", true).put("exitCode", 0));
                // UI action is deferred to let TLS flush before Activity leaves
                // the foreground and intentionally closes all LAN sessions.
                final Session approvedSession = active;
                approvedAction.launch(command, () -> isStillAuthorized(approvedSession, owner, ip));
                notice.show("Phone owner approved: " + AndroidSupportActions.description(command));
                return;
            }

            // No /system/bin/sh -c, su, pm install or arbitrary ProcessBuilder.
            // Read-only diagnostics use an exact Android API allowlist.
            String output = AndroidDiagnostics.run(context, command, link);
            if (!running.get() || socket.isClosed()) return;
            if (output.getBytes(StandardCharsets.UTF_8).length > 64 * 1024) {
                fail(socket, "Diagnostic output limit exceeded."); return;
            }
            send(socket, new JSONObject()
                    .put("event", "output").put("stream", "stdout").put("data", output));
            send(socket, new JSONObject()
                    .put("event", "done").put("ok", true).put("exitCode", 0));
            notice.show("Completed permitted diagnostic command (contents not logged).");
        } catch (Exception denied) {
            send(socket, new JSONObject().put("event", "done").put("ok", false)
                    .put("error", "Android diagnostic command denied or unavailable.")
                    .put("exitCode", -1));
        } finally {
            synchronized (guard) { busy = false; }
        }
    }

    private static float normalized(JSONObject request, String key) {
        Object value = request.opt(key);
        if (!(value instanceof Number)) throw new SecurityException("Coordinate must be numeric.");
        double x = ((Number) value).doubleValue();
        if (!Double.isFinite(x) || x < 0 || x > 1) throw new SecurityException("Coordinate out of bounds.");
        return (float) x;
    }

    private void handleRemoteInput(SSLSocket socket, JSONObject request) throws Exception {
        if (!RemoteControlPermit.canControl() || !ControlledAccessibilityService.enabled()) {
            fail(socket, "Phone owner has not enabled Accessibility remote input for this session.");
            return;
        }
        String action = request.optString("kind", "");
        try {
            switch (action) {
                case "tap":
                    ControlledAccessibilityService.tap(normalized(request, "x"),
                            normalized(request, "y"));
                    break;
                case "swipe": {
                    float x = normalized(request, "x"), y = normalized(request, "y");
                    float endX = normalized(request, "endX"), endY = normalized(request, "endY");
                    Object ms = request.opt("durationMs");
                    if (!(ms instanceof Integer)) throw new SecurityException("Gesture duration must be integer");
                    int durationMs = (Integer) ms;
                    if (durationMs < 100 || durationMs > 1500) throw new SecurityException("Gesture duration invalid");
                    ControlledAccessibilityService.swipe(x, y, endX, endY, durationMs);
                    break;
                }
                case "back":
                case "home":
                case "recents":
                    ControlledAccessibilityService.global(action);
                    break;
                case "text": {
                    String text = request.optString("text", "");
                    if (text.isEmpty() || text.length() > 160 || text.indexOf(10) >= 0 || text.indexOf(13) >= 0) throw new SecurityException("Text length invalid");
                    ControlledAccessibilityService.type(text);
                    break;
                }
                default:
                    throw new SecurityException("Unsupported Android remote input.");
            }
            send(socket, new JSONObject().put("ok", true).put("accepted", true)
                    .put("kind", action));
        } catch (SecurityException invalid) {
            fail(socket, "Remote input denied by the phone policy.");
        }
    }

    private boolean isStillAuthorized(Session expected, Paired owner, String ip) {
        if (!LanNetwork.permitsPeer(context, link, ip)) return false;
        synchronized (guard) {
            long now = SystemClock.elapsedRealtime();
            return running.get() && session == expected
                    && paired.get(owner.id) == owner
                    && expected.ip.equals(ip)
                    && now - expected.created <= SESSION_MAX_MS
                    && now - expected.lastUsed <= SESSION_IDLE_MS;
        }
    }

    private void handlePair(SSLSocket socket, JSONObject request, String ip) throws Exception {
        if (request.has("segmentTag") && !secureEquals(segmentTag, request.optString("segmentTag", ""))) {
            fail(socket, "Network segment mismatch."); return;
        }
        String provided = request.optString("code", "");
        String label = request.optString("label", "");
        String expected;
        synchronized (guard) {
            if (SystemClock.elapsedRealtime() >= expires || attempts >= 5) {
                fail(socket, "Pairing closed or expired."); return;
            }
            attempts++;
            expected = code;
        }
        if (provided.length() != 8 || !secureEquals(provided, expected)
                || label.isEmpty() || label.length() > 60 || !label.matches("[a-zA-Z0-9 _.-]+")) {
            fail(socket, "Pairing rejected."); return;
        }
        if (!approval.ask("pair", label, ip, 90) || !running.get() || socket.isClosed()
                || !LanNetwork.permitsPeer(context, link, ip)) {
            fail(socket, "Pairing not approved."); return;
        }
        Paired owner;
        synchronized (guard) {
            if (!secureEquals(expected, code) || SystemClock.elapsedRealtime() >= expires) {
                fail(socket, "Pairing expired."); return;
            }
            owner = new Paired(UUID.randomUUID().toString(), secret(), ip, label);
            paired.put(owner.id, owner);
            expires = 0; // Pair code is single-use even within its 120s window.
        }
        send(socket, new JSONObject().put("ok", true)
                .put("pairId", owner.id).put("pairToken", owner.secret)
                .put("platform", "android").put("deviceName", "Android " + Build.MODEL)
                .put("segmentTag", segmentTag));
        notice.show("Paired controller " + label + " on local network.");
    }

    private void handleOpen(SSLSocket socket, Paired owner, String ip) throws Exception {
        synchronized (guard) {
            long now = SystemClock.elapsedRealtime();
            if (session != null && (now - session.lastUsed > SESSION_IDLE_MS
                    || now - session.created > SESSION_MAX_MS)) {
                session = null;
            }
            if (session != null) { fail(socket, "A support session is already active."); return; }
        }
        if (!approval.ask("session", owner.label, ip, 90) || !running.get() || socket.isClosed()
                || !LanNetwork.permitsPeer(context, link, ip)) {
            fail(socket, "Session not approved."); return;
        }
        Session created;
        synchronized (guard) {
            if (session != null || !paired.containsKey(owner.id)) {
                fail(socket, "Session rejected."); return;
            }
            created = new Session(UUID.randomUUID().toString(), secret(), owner.id, ip,
                    SystemClock.elapsedRealtime());
            session = created;
            RemoteControlPermit.session(true);
        }
        send(socket, new JSONObject().put("ok", true)
                .put("sessionId", created.id).put("sessionToken", created.secret));
        notice.show("Support session approved. Android diagnostics available.");
    }

    private static boolean secureEquals(String expected, String supplied) {
        byte[] a = expected.getBytes(StandardCharsets.UTF_8);
        byte[] b = supplied.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(a, b);
    }

    private String secret() {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        StringBuilder hex = new StringBuilder(64);
        for (byte v : bytes) hex.append(String.format(Locale.US, "%02x", v & 0xff));
        return hex.toString();
    }

    private static void send(SSLSocket socket, JSONObject payload) throws Exception {
        OutputStream out = socket.getOutputStream();
        byte[] bytes = (payload.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        out.write(bytes);
        out.flush();
    }

    private static void fail(SSLSocket socket, String reason) throws Exception {
        send(socket, new JSONObject().put("ok", false).put("error", reason));
    }

    private static void closeQuietly(SSLSocket socket) {
        try { socket.close(); } catch (Exception ignored) {}
    }

    @Override public void close() {
        fileExchange.clear();
        RemoteControlPermit.revoke();
        ScreenProjectionService.stop(context);
        if (!running.getAndSet(false)) return;
        synchronized (guard) {
            paired.clear(); session = null; busy = false; expires = 0;
        }
        SSLServerSocket listener = tlsListener;
        tlsListener = null;
        if (listener != null) try { listener.close(); } catch (Exception ignored) {}
        DatagramSocket discovery = udpListener;
        udpListener = null;
        if (discovery != null) discovery.close();
        for (SSLSocket socket : sockets) closeQuietly(socket);
        ThreadPoolExecutor workers = pool;
        if (workers != null) workers.shutdownNow();
        WifiManager.MulticastLock lock = multicastLock;
        multicastLock = null;
        if (lock != null && lock.isHeld()) lock.release();
        notice.show("LAN sharing OFF. All pairing and sessions erased.");
    }
}
