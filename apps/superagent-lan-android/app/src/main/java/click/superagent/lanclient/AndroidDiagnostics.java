package click.superagent.lanclient;

import android.app.ActivityManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.hardware.Sensor;
import android.hardware.SensorManager;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.os.StatFs;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.DisplayMetrics;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * Android API-backed diagnostic allowlist; no shell, filesystem browsing,
 * personal-data extraction, Package visibility overrides, or root/ADB.
 */
public final class AndroidDiagnostics {
    private AndroidDiagnostics() {}

    public static final List<String> ALLOWED = List.of(
            "android.info", "android.network", "android.battery", "android.storage",
            "android.memory", "android.power", "android.display", "android.wifi",
            "android.audio", "android.sensors", "android.app", "android.uptime",
            "android.network_details", "android.health", "android.support_status",
            "id", "uname -a", "getprop ro.product.model",
            "getprop ro.build.version.release", "getprop ro.build.version.sdk"
    );

    public static boolean allowed(String command) {
        return command != null && ALLOWED.contains(command);
    }

    public static String run(Context context, String command, LanNetwork.Link link) throws Exception {
        if (!allowed(command)) {
            throw new SecurityException("Unsupported Android command. Exact allowlist only.");
        }
        switch (command) {
            case "android.health":
                return AndroidHealthSnapshot.health(context, link).toString(2) + "\n";
            case "android.support_status":
                return AndroidHealthSnapshot.supportStatus(context).toString(2) + "\n";
            case "android.info":
                return new JSONObject()
                        .put("platform", "android")
                        .put("manufacturer", Build.MANUFACTURER)
                        .put("brand", Build.BRAND)
                        .put("model", Build.MODEL)
                        .put("device", Build.DEVICE)
                        .put("version", Build.VERSION.RELEASE)
                        .put("sdk", Build.VERSION.SDK_INT)
                        .put("securityPatch", Build.VERSION.SECURITY_PATCH)
                        .put("supportedAbis", new JSONArray(Arrays.asList(Build.SUPPORTED_ABIS)))
                        .toString(2) + "\n";
            case "android.network":
                if (link == null) return new JSONObject()
                        .put("transport", "outbound HTTPS tunnel")
                        .put("localIPv4", JSONObject.NULL)
                        .put("prefix", JSONObject.NULL)
                        .put("vpn", JSONObject.NULL)
                        .put("privacy", "Local/public IP not exposed by tunnel diagnostics")
                        .toString(2) + "\n";
                return new JSONObject()
                        .put("transport", link.transport)
                        .put("localIPv4", link.ip)
                        .put("prefix", link.prefix)
                        .put("vpn", false)
                        .toString(2) + "\n";
            case "android.network_details": {
                ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
                android.net.Network selected = link == null
                        ? manager == null ? null : manager.getActiveNetwork()
                        : link.network;
                NetworkCapabilities caps = manager == null || selected == null
                        ? null : manager.getNetworkCapabilities(selected);
                return new JSONObject()
                        .put("transport", link == null ? "outbound HTTPS tunnel" : link.transport)
                        .put("localIPv4", link == null ? JSONObject.NULL : link.ip)
                        .put("prefix", link == null ? JSONObject.NULL : link.prefix)
                        .put("internetCapability", caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
                        .put("validatedInternet", caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
                        .put("notMetered", caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
                        .put("upstreamKbpsEstimate", caps == null ? -1 : caps.getLinkUpstreamBandwidthKbps())
                        .put("downstreamKbpsEstimate", caps == null ? -1 : caps.getLinkDownstreamBandwidthKbps())
                        .put("privacy", "No SSID, MAC, configured network list, or public IP collected")
                        .toString(2) + "\n";
            }
            case "android.battery": {
                Intent battery = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
                if (battery == null) return "Battery status unavailable\n";
                int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                int health = battery.getIntExtra(BatteryManager.EXTRA_HEALTH, -1);
                int temperature = battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1);
                return new JSONObject()
                        .put("batteryPercent", scale > 0 ? Math.round(level * 100f / scale) : -1)
                        .put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING
                                || status == BatteryManager.BATTERY_STATUS_FULL)
                        .put("healthCode", health)
                        .put("temperatureCelsius", temperature >= 0 ? temperature / 10.0 : JSONObject.NULL)
                        .toString(2) + "\n";
            }
            case "android.storage": {
                StatFs stat = new StatFs(context.getFilesDir().getAbsolutePath());
                return new JSONObject()
                        .put("appDataVolumeBytes", stat.getTotalBytes())
                        .put("appDataAvailableBytes", stat.getAvailableBytes())
                        .put("scope", "App storage volume; no access to private user documents")
                        .toString(2) + "\n";
            }
            case "android.memory": {
                ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
                if (manager == null) throw new IllegalStateException("Memory service unavailable");
                ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
                manager.getMemoryInfo(memory);
                return new JSONObject()
                        .put("physicalRamBytes", memory.totalMem)
                        .put("availableRamBytes", memory.availMem)
                        .put("lowMemory", memory.lowMemory)
                        .put("lowMemoryThresholdBytes", memory.threshold)
                        .put("appHeapClassMB", manager.getMemoryClass())
                        .toString(2) + "\n";
            }
            case "android.power": {
                PowerManager manager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                return new JSONObject()
                        .put("batterySaverEnabled", manager != null && manager.isPowerSaveMode())
                        .put("screenInteractive", manager != null && manager.isInteractive())
                        .toString(2) + "\n";
            }
            case "android.display": {
                DisplayMetrics metrics = context.getResources().getDisplayMetrics();
                int brightness = Settings.System.getInt(
                        context.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS, -1);
                return new JSONObject()
                        .put("widthPx", metrics.widthPixels)
                        .put("heightPx", metrics.heightPixels)
                        .put("densityDpi", metrics.densityDpi)
                        .put("densityScale", metrics.density)
                        .put("systemBrightness0to255", brightness)
                        .toString(2) + "\n";
            }
            case "android.wifi": {
                WifiManager manager = (WifiManager) context.getApplicationContext()
                        .getSystemService(Context.WIFI_SERVICE);
                return new JSONObject()
                        .put("wifiEnabled", manager != null && manager.isWifiEnabled())
                        .put("activeLanTransport", link == null ? "HTTPS tunnel" : link.transport)
                        .put("privateIPv4", link == null ? JSONObject.NULL : link.ip)
                        .toString(2) + "\n";
            }
            case "android.audio": {
                AudioManager manager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
                if (manager == null) throw new IllegalStateException("Audio service unavailable");
                return new JSONObject()
                        .put("mediaVolume", manager.getStreamVolume(AudioManager.STREAM_MUSIC))
                        .put("mediaVolumeMax", manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC))
                        .put("ringerMode", manager.getRingerMode())
                        .toString(2) + "\n";
            }
            case "android.sensors": {
                SensorManager manager = (SensorManager) context.getSystemService(Context.SENSOR_SERVICE);
                JSONArray sensors = new JSONArray();
                int total = 0;
                if (manager != null) {
                    List<Sensor> list = manager.getSensorList(Sensor.TYPE_ALL);
                    total = list.size();
                    // A bounded list of sensor *types*, no sensor readings or recordings.
                    for (int i = 0; i < Math.min(24, list.size()); i++) {
                        sensors.put(new JSONObject().put("type", list.get(i).getType())
                                .put("name", list.get(i).getName().substring(
                                        0, Math.min(80, list.get(i).getName().length()))));
                    }
                }
                return new JSONObject()
                        .put("sensorCount", total)
                        .put("first24Types", sensors)
                        .put("readingsCaptured", false)
                        .toString(2) + "\n";
            }
            case "android.app": {
                PackageInfo app = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
                NotificationManager notifications = (NotificationManager)
                        context.getSystemService(Context.NOTIFICATION_SERVICE);
                return new JSONObject()
                        .put("package", context.getPackageName())
                        .put("versionName", app.versionName)
                        .put("versionCode", app.getLongVersionCode())
                        .put("notificationsEnabled", notifications != null && notifications.areNotificationsEnabled())
                        .put("scope", "Current LAN Client app only; installed-app inventory disabled")
                        .toString(2) + "\n";
            }
            case "android.uptime":
                return new JSONObject()
                        .put("uptimeMilliseconds", SystemClock.uptimeMillis())
                        .put("elapsedRealtimeMilliseconds", SystemClock.elapsedRealtime())
                        .toString(2) + "\n";
            case "id":
                return "uid=" + android.os.Process.myUid() + " (app sandbox)\n";
            case "uname -a":
                return System.getProperty("os.name", "Linux") + " "
                        + System.getProperty("os.version", "unknown") + " (Android app sandbox)\n";
            case "getprop ro.product.model":
                return Build.MODEL + "\n";
            case "getprop ro.build.version.release":
                return Build.VERSION.RELEASE + "\n";
            case "getprop ro.build.version.sdk":
                return String.format(Locale.US, "%d\n", Build.VERSION.SDK_INT);
            default:
                throw new SecurityException("Command denied.");
        }
    }
}
