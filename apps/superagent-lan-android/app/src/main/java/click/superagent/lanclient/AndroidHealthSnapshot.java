package click.superagent.lanclient;

import android.app.NotificationManager;
import android.content.Context;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Bounded, read-only snapshots from existing, allowlisted Android API diagnostics.
 * No screenshots, input text, SSIDs, MAC addresses, installed-app lists or files.
 */
public final class AndroidHealthSnapshot {
    private AndroidHealthSnapshot() {}

    private static JSONObject section(Context context, String command, LanNetwork.Link link) {
        try {
            return new JSONObject(AndroidDiagnostics.run(context, command, link));
        } catch (Exception unavailable) {
            // Do not expose exception strings, paths, or platform internals to a remote session.
            JSONObject result = new JSONObject();
            try { result.put("unavailable", true); }
            catch (JSONException ignored) { /* Fixed key and boolean value. */ }
            return result;
        }
    }

    private static void signal(JSONArray signals, String code, String level, String description) throws JSONException {
        signals.put(new JSONObject()
                .put("code", code).put("level", level).put("message", description));
    }

    private static boolean absent(JSONObject object) {
        return object.optBoolean("unavailable", false);
    }

    public static JSONObject health(Context context, LanNetwork.Link link) throws Exception {
        JSONObject battery = section(context, "android.battery", link);
        JSONObject memory = section(context, "android.memory", link);
        JSONObject storage = section(context, "android.storage", link);
        JSONObject network = section(context, "android.network_details", link);
        JSONObject power = section(context, "android.power", link);
        JSONObject app = section(context, "android.app", link);
        JSONObject device = section(context, "android.info", link);
        JSONObject sections = new JSONObject()
                .put("device", device)
                .put("battery", battery)
                .put("memory", memory)
                .put("storage", storage)
                .put("network", network)
                .put("power", power)
                .put("app", app);
        JSONArray signals = new JSONArray();
        int unavailableCount = 0;
        for (String sectionName : new String[]{"device", "battery", "memory", "storage", "network", "power", "app"}) {
            if (absent(sections.getJSONObject(sectionName))) unavailableCount++;
        }

        int batteryPercent = battery.optInt("batteryPercent", -1);
        if (batteryPercent >= 0 && batteryPercent <= 15 && !battery.optBoolean("charging", false)) {
            signal(signals, "LOW_BATTERY", "warning",
                    "Phone battery is low and not charging.");
        }
        // Android battery temperatures are in tenths of degrees Celsius, normalized by android.battery.
        double temperature = battery.optDouble("temperatureCelsius", Double.NaN);
        if (Double.isFinite(temperature) && temperature >= 42.0 && temperature <= 100) {
            signal(signals, "WARM_BATTERY", "warning",
                    "Battery temperature is elevated; reduce workload if needed.");
        }
        if (!absent(memory) && memory.optBoolean("lowMemory", false)) {
            signal(signals, "LOW_MEMORY", "warning",
                    "Android reports system memory pressure.");
        }
        long volumeBytes = storage.optLong("appDataVolumeBytes", -1);
        long availableBytes = storage.optLong("appDataAvailableBytes", -1);
        if (volumeBytes > 0 && availableBytes >= 0 && availableBytes <= volumeBytes
                && availableBytes < volumeBytes / 10) {
            signal(signals, "LOW_STORAGE", "warning",
                    "Less than 10% of the app data volume remains available.");
        }
        if (!absent(network) && network.optBoolean("internetCapability", false)
                && !network.optBoolean("validatedInternet", false)) {
            signal(signals, "NETWORK_NOT_VALIDATED", "info",
                    "Android has not validated Internet access; local LAN may still work.");
        }
        if (!absent(power) && power.optBoolean("batterySaverEnabled", false)) {
            signal(signals, "BATTERY_SAVER", "info",
                    "Battery saver can limit remote support performance.");
        }

        return new JSONObject()
                .put("schemaVersion", 1)
                .put("kind", "android.health")
                .put("capturedAtEpochMillis", System.currentTimeMillis())
                .put("readOnly", true)
                .put("partial", unavailableCount > 0)
                .put("unavailableSections", unavailableCount)
                .put("warningCount", countWarnings(signals))
                .put("signals", signals)
                .put("sections", sections)
                .put("privacy", "Device and app health only; no screenshots, private files, SSIDs, MAC, or app inventory");
    }

    private static int countWarnings(JSONArray signals) {
        int count = 0;
        for (int i = 0; i < signals.length(); i++) {
            if ("warning".equals(signals.optJSONObject(i).optString("level"))) count++;
        }
        return count;
    }

    public static JSONObject supportStatus(Context context) throws JSONException {
        NotificationManager notifications = (NotificationManager)
                context.getSystemService(Context.NOTIFICATION_SERVICE);
        boolean session = RemoteControlPermit.hasApprovedSession();
        boolean screenActive = session && ScreenProjectionService.isActive()
                && RemoteControlPermit.canView();
        boolean accessibility = ControlledAccessibilityService.enabled();
        boolean inputAllowed = screenActive && accessibility && RemoteControlPermit.canControl();
        return new JSONObject()
                .put("schemaVersion", 1)
                .put("kind", "android.support_status")
                .put("capturedAtElapsedMillis", SystemClock.elapsedRealtime())
                .put("sessionApproved", session)
                .put("screenSharing", screenActive)
                .put("accessibilityEnabled", accessibility)
                .put("remoteInputAllowed", inputAllowed)
                .put("notificationsEnabled", notifications != null && notifications.areNotificationsEnabled())
                .put("ownerCanStop", true)
                .put("privacy", "Capability booleans only; no screen content, text or session credentials");
    }
}
