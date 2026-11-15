package click.superagent.lanclient;

import android.graphics.Bitmap;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;

/** One-shot Android TV invitation displayed ON the device; no camera required. */
final class AndroidTvQrPairing {
    private AndroidTvQrPairing() {}

    static final class Ticket {
        final String url, id, challenge, pollToken;
        final long expiresAt;
        Ticket(String url, String id, String challenge, String pollToken, long expiresAt) {
            this.url = url; this.id = id; this.challenge = challenge;
            this.pollToken = pollToken; this.expiresAt = expiresAt;
        }
        String publicQr() throws Exception {
            return new JSONObject()
                    .put("k", "satv").put("v", 1).put("u", url)
                    .put("i", id).put("h", challenge).put("e", expiresAt)
                    .toString();
        }
    }

    static String requireHttpsOrigin(String value) throws Exception {
        if (value == null || value.length() > 240 || !value.equals(value.trim()))
            throw new IllegalArgumentException("Enter a valid HTTPS Core URL.");
        URL parsed = new URL(value);
        if (!"https".equalsIgnoreCase(parsed.getProtocol()) || parsed.getUserInfo() != null
                || (parsed.getPath() != null && !parsed.getPath().isEmpty()
                && !"/".equals(parsed.getPath()))
                || parsed.getQuery() != null || parsed.getRef() != null
                || parsed.getHost() == null || parsed.getHost().isEmpty())
            throw new IllegalArgumentException("Use the trusted HTTPS Core origin (no path, query or credentials).");
        return parsed.getProtocol().toLowerCase(Locale.ROOT) + "://" + parsed.getAuthority();
    }

    static Ticket create(String origin, String deviceName) throws Exception {
        String url = requireHttpsOrigin(origin);
        byte[] random = new byte[32];
        new SecureRandom().nextBytes(random);
        StringBuilder challenge = new StringBuilder(64);
        for (byte b : random) challenge.append(String.format(Locale.ROOT, "%02x", b & 255));
        JSONObject response = post(url + "/api/device-tunnel/tv/request", new JSONObject()
                .put("challenge", challenge.toString())
                .put("name", deviceName.length() > 60 ? deviceName.substring(0, 60) : deviceName));
        JSONObject request = response.getJSONObject("request");
        String id = request.getString("id");
        String token = request.getString("pollToken");
        long expiresAt = request.getLong("expiresAt");
        if (!id.matches("[a-fA-F0-9-]{36}") || !token.matches("[a-f0-9]{64}")
                || expiresAt <= System.currentTimeMillis() || expiresAt > System.currentTimeMillis() + 185_000L)
            throw new IllegalStateException("Invalid TV pairing response.");
        return new Ticket(url, id, challenge.toString(), token, expiresAt);
    }

    static JSONObject poll(Ticket ticket) throws Exception {
        return post(ticket.url + "/api/device-tunnel/tv/poll", new JSONObject()
                .put("id", ticket.id).put("pollToken", ticket.pollToken))
                .getJSONObject("result");
    }

    static String validatedSetup(Ticket ticket, JSONObject reply) throws Exception {
        if (!"approved".equals(reply.optString("state"))
                || !reply.optString("inviteId").matches("[a-fA-F0-9-]{36}")
                || !reply.optString("code").matches("[0-9]{10}")
                || reply.optLong("expiresAt") <= System.currentTimeMillis()
                || reply.optLong("expiresAt") > System.currentTimeMillis() + 11 * 60_000L)
            throw new IllegalStateException("TV pairing invitation is expired or invalid.");
        // Reuse the existing auto-pair pipeline, with an accurate controller label.
        return new JSONObject().put("kind", "superagent-device-tunnel").put("v", 1)
                .put("url", ticket.url).put("inviteId", reply.getString("inviteId"))
                .put("code", reply.getString("code")).put("expiresAt", reply.getLong("expiresAt"))
                .put("autoPair", true).put("controller", "SuperAgent MCP TV").toString();
    }

    static Bitmap bitmap(String value, int pixels) throws WriterException {
        Map<EncodeHintType, Object> options = new HashMap<>();
        options.put(EncodeHintType.MARGIN, 2);
        BitMatrix matrix = new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE,
                pixels, pixels, options);
        int width = matrix.getWidth(), height = matrix.getHeight();
        int[] data = new int[width * height];
        for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++)
                data[y * width + x] = matrix.get(x, y) ? 0xff172438 : 0xffffffff;
        return Bitmap.createBitmap(data, width, height, Bitmap.Config.ARGB_8888);
    }

    private static JSONObject post(String target, JSONObject body) throws Exception {
        HttpsURLConnection conn = (HttpsURLConnection) new URL(target).openConnection();
        conn.setConnectTimeout(10_000);
        conn.setReadTimeout(10_000);
        conn.setRequestMethod("POST");
        conn.setInstanceFollowRedirects(false);
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Accept", "application/json");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 1024) throw new IllegalArgumentException("TV request too large.");
        try {
            conn.setFixedLengthStreamingMode(bytes.length);
            conn.getOutputStream().write(bytes);
            int status = conn.getResponseCode();
            InputStream stream = status >= 200 && status < 300
                    ? conn.getInputStream() : conn.getErrorStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (stream != null) {
                byte[] buffer = new byte[1024]; int n;
                while ((n = stream.read(buffer)) != -1) {
                    if (out.size() + n > 4096) throw new IllegalStateException("TV response too large.");
                    out.write(buffer, 0, n);
                }
            }
            JSONObject result = new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
            if (status != 200 || !result.optBoolean("success", false))
                throw new IllegalStateException(result.optString("error", "TV connection failed."));
            return result;
        } finally {
            conn.disconnect();
        }
    }
}
