package click.superagent.lanclient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Visible, foreground-owned reverse HTTPS relay for SuperAgent Device Tunnel.
 * The public Core never receives the local LAN private key. Every tunneled
 * request is replayed through the existing local TLS engine so pairing codes,
 * fingerprint pinning and on-device approvals remain authoritative.
 */
public final class TunnelRelayClient {
    public interface Notice { void show(String message); }

    private final Notice notice;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile Thread worker;
    private volatile String deviceId;
    private volatile String token;

    public TunnelRelayClient(Notice notice) {
        this.notice = notice;
    }

    public boolean isRunning() { return running.get(); }

    public void start(String setupJson, String localIp, int localPort,
                      String fingerprint, String pairingCode, String deviceName) {
        if (!running.compareAndSet(false, true))
            throw new IllegalStateException("Device Tunnel is already running.");
        final Setup setup;
        try {
            setup = parseSetup(setupJson);
        } catch (Exception error) {
            running.set(false);
            throw new IllegalArgumentException(error.getMessage());
        }
        worker = new Thread(() -> runLoop(setup, localIp, localPort, fingerprint, pairingCode, deviceName),
                "superagent-device-tunnel");
        worker.setDaemon(true);
        worker.start();
    }

    public void stop() {
        running.set(false);
        Thread live = worker;
        worker = null;
        if (live != null) live.interrupt();
        token = null;
        deviceId = null;
    }

    private void runLoop(Setup setup, String localIp, int localPort,
                         String fingerprint, String pairingCode, String deviceName) {
        int failures = 0;
        try {
            JSONObject enrolled = post(setup.baseUrl + "/api/device-tunnel/enroll",
                    null, null, new JSONObject()
                            .put("inviteId", setup.inviteId)
                            .put("code", setup.code)
                            .put("name", safeName(deviceName))
                            .put("platform", "android")
                            .put("fingerprint", fingerprint.toLowerCase(Locale.ROOT)),
                    15_000);
            JSONObject device = enrolled.optJSONObject("device");
            String newId = device == null ? "" : device.optString("id", "");
            String newToken = enrolled.optString("token", "");
            if (!newId.matches("[a-fA-F0-9-]{36}") || !newToken.matches("[a-f0-9]{64}"))
                throw new IllegalStateException("Malformed Device Tunnel enrollment response.");
            deviceId = newId;
            token = newToken;
            setup.code = "";
            notice.show("Device Tunnel connected through HTTPS.");

            if (setup.autoPair) {
                if (pairingCode == null || !pairingCode.matches("[0-9]{8}"))
                    throw new IllegalStateException("QR pairing code is unavailable.");
                Thread autoPair = new Thread(() -> {
                    try {
                        JSONObject paired = post(setup.baseUrl + "/api/device-tunnel/qr-pair",
                                deviceId, token, new JSONObject()
                                        .put("code", pairingCode)
                                        .put("fingerprint", fingerprint.toLowerCase(Locale.ROOT))
                                        .put("controller", setup.controller),
                                130_000);
                        JSONObject deviceResult = paired.optJSONObject("device");
                        String label = deviceResult == null ? "SuperAgent" : deviceResult.optString("label", "SuperAgent");
                        notice.show("QR pairing approved with " + safeName(label) + ".");
                    } catch (Exception error) {
                        if (running.get()) notice.show("QR pairing failed: " + safeError(error));
                    }
                }, "superagent-device-tunnel-qr-pair");
                autoPair.setDaemon(true);
                autoPair.start();
            }

            while (running.get()) {
                try {
                    JSONObject polled = post(setup.baseUrl + "/api/device-tunnel/poll",
                            deviceId, token, new JSONObject().put("waitMs", 25_000), 35_000);
                    failures = 0;
                    if (polled.isNull("request")) continue;
                    JSONObject request = polled.optJSONObject("request");
                    if (request == null) throw new IllegalStateException("Malformed tunnel request.");
                    String requestId = request.optString("requestId", "");
                    JSONObject body = request.optJSONObject("body");
                    int maxReplyChars = request.optInt("maxReplyChars", 0);
                    if (!requestId.matches("[a-fA-F0-9-]{36}") || body == null
                            || maxReplyChars < 4096 || maxReplyChars > 700 * 1024)
                        throw new IllegalStateException("Malformed tunnel request.");

                    JSONArray frames;
                    try {
                        frames = relayLocal(localIp, localPort, fingerprint, body, maxReplyChars);
                    } catch (Exception error) {
                        frames = new JSONArray().put(new JSONObject()
                                .put("ok", false)
                                .put("error", safeError(error)));
                    }
                    post(setup.baseUrl + "/api/device-tunnel/reply", deviceId, token,
                            new JSONObject().put("requestId", requestId).put("frames", frames),
                            15_000);
                } catch (Exception error) {
                    if (!running.get()) break;
                    failures++;
                    notice.show("Device Tunnel reconnecting.");
                    try {
                        Thread.sleep(Math.min(10_000L, 500L << Math.min(5, failures)));
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
        } catch (Exception error) {
            if (running.get()) notice.show("Device Tunnel stopped: " + safeError(error));
        } finally {
            running.set(false);
            token = null;
            deviceId = null;
        }
    }

    private JSONArray relayLocal(String host, int port, String fingerprint,
                                 JSONObject body, int maxReplyChars) throws Exception {
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, trustLocalSelfSigned(), new SecureRandom());
        try (SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket(host, port)) {
            socket.setEnabledProtocols(new String[]{"TLSv1.3"});
            socket.setSoTimeout(120_000);
            socket.startHandshake();
            X509Certificate cert = (X509Certificate) socket.getSession().getPeerCertificates()[0];
            String observed = sha256(cert.getEncoded());
            if (!constantTimeHex(observed, fingerprint.toLowerCase(Locale.ROOT)))
                throw new IllegalStateException("Local TLS fingerprint changed.");

            BufferedWriter writer = new BufferedWriter(
                    new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
            writer.write(body.toString());
            writer.write("\n");
            writer.flush();

            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            JSONArray frames = new JSONArray();
            int chars = 0;
            String line;
            while ((line = reader.readLine()) != null) {
                chars += line.length();
                if (chars > maxReplyChars) throw new IllegalStateException("Local reply exceeded bound.");
                if (line.isEmpty()) continue;
                JSONObject frame = new JSONObject(line);
                frames.put(frame);
                if ("done".equals(frame.optString("event"))
                        || (frame.has("ok") && !"output".equals(frame.optString("event"))))
                    return frames;
            }
            if (frames.length() == 0) throw new IllegalStateException("Local device closed without reply.");
            return frames;
        }
    }

    private JSONObject post(String endpoint, String id, String authToken,
                            JSONObject body, int timeoutMs) throws Exception {
        URL url = new URL(endpoint);
        if (!"https".equalsIgnoreCase(url.getProtocol()))
            throw new IllegalArgumentException("Device Tunnel endpoint must use HTTPS.");
        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        connection.setConnectTimeout(Math.min(timeoutMs, 15_000));
        connection.setReadTimeout(timeoutMs);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Accept", "application/json");
        if (id != null && authToken != null) {
            connection.setRequestProperty("X-SuperAgent-Device-Id", id);
            connection.setRequestProperty("Authorization", "Device " + authToken);
        }
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        if (payload.length > 700 * 1024) throw new IllegalArgumentException("Tunnel request too large.");
        connection.setFixedLengthStreamingMode(payload.length);
        connection.getOutputStream().write(payload);

        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300
                ? connection.getInputStream() : connection.getErrorStream();
        String text = readLimited(stream, 720 * 1024);
        connection.disconnect();
        JSONObject result = text.isEmpty() ? new JSONObject() : new JSONObject(text);
        if (status < 200 || status >= 300 || !result.optBoolean("success", false))
            throw new IllegalStateException(result.optString("error", "Device Tunnel HTTP " + status));
        return result;
    }

    private static String readLimited(InputStream stream, int limit) throws Exception {
        if (stream == null) return "";
        byte[] buffer = new byte[8192];
        int total = 0, count;
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        while ((count = stream.read(buffer)) >= 0) {
            total += count;
            if (total > limit) throw new IllegalStateException("Tunnel response too large.");
            out.write(buffer, 0, count);
        }
        return out.toString(StandardCharsets.UTF_8.name());
    }

    private static TrustManager[] trustLocalSelfSigned() {
        return new TrustManager[]{new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) {}
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) {}
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        }};
    }

    private static String sha256(byte[] bytes) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder out = new StringBuilder(64);
        for (byte value : hash) out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return out.toString();
    }

    private static boolean constantTimeHex(String a, String b) {
        if (a.length() != b.length()) return false;
        int diff = 0;
        for (int i = 0; i < a.length(); i++) diff |= a.charAt(i) ^ b.charAt(i);
        return diff == 0;
    }

    private static String safeName(String value) {
        String name = value == null ? "Android Device" : value
                .replaceAll("[\\x00-\\x1f\\x7f]", "").trim();
        if (name.isEmpty()) name = "Android Device";
        return name.substring(0, Math.min(60, name.length()));
    }

    private static String safeError(Exception error) {
        String message = error.getMessage();
        if (message == null || message.isEmpty()) message = error.getClass().getSimpleName();
        message = message.replaceAll("\\b\\d{8,12}\\b", "[code]");
        return message.substring(0, Math.min(180, message.length()));
    }

    private static Setup parseSetup(String text) throws Exception {
        JSONObject setup = new JSONObject(text == null ? "" : text.trim());
        boolean compactQr = "sat".equals(setup.optString("k", ""));
        boolean legacyQr = "superagent-device-tunnel".equals(setup.optString("kind", ""));
        boolean qr = compactQr || legacyQr;

        if (compactQr) {
            if (setup.length() != 6 || setup.optInt("v", 0) != 1
                    || !setup.has("u") || !setup.has("i") || !setup.has("c") || !setup.has("e"))
                throw new IllegalArgumentException("Invalid compact SuperAgent QR payload.");
        } else if (legacyQr) {
            if (setup.length() != 8 || setup.optInt("v", 0) != 1
                    || !setup.has("url") || !setup.has("inviteId") || !setup.has("code")
                    || !setup.has("expiresAt") || !setup.optBoolean("autoPair", false)
                    || !setup.has("controller"))
                throw new IllegalArgumentException("Invalid legacy SuperAgent Device Tunnel QR payload.");
        } else if (setup.length() != 3 || !setup.has("url") || !setup.has("inviteId") || !setup.has("code")) {
            throw new IllegalArgumentException("Paste the complete Device Tunnel setup JSON from SuperAgent Tray.");
        }

        String rawUrl = compactQr ? setup.getString("u") : setup.getString("url");
        String inviteId = compactQr ? setup.getString("i") : setup.getString("inviteId");
        String code = compactQr ? setup.getString("c") : setup.getString("code");
        long expiresAt = compactQr ? setup.optLong("e", 0L) : legacyQr ? setup.optLong("expiresAt", 0L) : 0L;
        String controller = qr ? (legacyQr ? setup.optString("controller", "") : "SuperAgent Tray QR")
                : "SuperAgent Tray";

        URL url = new URL(rawUrl);
        if (!"https".equalsIgnoreCase(url.getProtocol()) || url.getUserInfo() != null
                || url.getQuery() != null || url.getRef() != null)
            throw new IllegalArgumentException("Device Tunnel URL must be clean HTTPS.");
        if (!inviteId.matches("[a-fA-F0-9-]{36}") || !code.matches("[0-9]{10}"))
            throw new IllegalArgumentException("Invalid Device Tunnel invitation.");
        if (qr && (expiresAt <= System.currentTimeMillis()
                || expiresAt > System.currentTimeMillis() + 11 * 60_000L))
            throw new IllegalArgumentException("Device Tunnel QR is expired or invalid.");
        if (!controller.matches("[A-Za-z0-9_ .-]{1,60}"))
            throw new IllegalArgumentException("Invalid QR controller label.");
        String base = url.getProtocol() + "://" + url.getAuthority();
        return new Setup(base, inviteId, code, qr, controller, expiresAt);
    }

    private static final class Setup {
        final String baseUrl, inviteId, controller;
        final boolean autoPair;
        final long expiresAt;
        String code;
        Setup(String baseUrl, String inviteId, String code, boolean autoPair,
              String controller, long expiresAt) {
            this.baseUrl = baseUrl; this.inviteId = inviteId; this.code = code;
            this.autoPair = autoPair; this.controller = controller; this.expiresAt = expiresAt;
        }
    }
}
