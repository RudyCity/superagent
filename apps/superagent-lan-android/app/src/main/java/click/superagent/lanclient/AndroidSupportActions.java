package click.superagent.lanclient;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.media.AudioManager;

import java.util.List;

/**
 * Exact-allowlist, user-approved *requests to open* local Android settings.
 * Does not change system settings, grant permissions or launch arbitrary intents.
 */
public final class AndroidSupportActions {
    private AndroidSupportActions() {}

    public static final List<String> ALLOWED = List.of(
            "android.action.open_wifi_settings",
            "android.action.open_bluetooth_settings",
            "android.action.open_display_settings",
            "android.action.open_battery_settings",
            "android.action.open_storage_settings",
            "android.action.open_app_settings",
            "android.action.open_app_info",
            "android.action.open_date_settings",
            "android.action.volume_up",
            "android.action.volume_down"
    );

    public static boolean allowed(String command) {
        return command != null && ALLOWED.contains(command);
    }

    public static String description(String command) {
        switch (command) {
            case "android.action.volume_up":
                return "Raise media volume one step";
            case "android.action.volume_down":
                return "Lower media volume one step";
            case "android.action.open_wifi_settings":
                return "Open Wi-Fi settings";
            case "android.action.open_bluetooth_settings":
                return "Open Bluetooth settings";
            case "android.action.open_display_settings":
                return "Open screen and display settings";
            case "android.action.open_battery_settings":
                return "Open battery saver settings";
            case "android.action.open_storage_settings":
                return "Open storage settings";
            case "android.action.open_app_settings":
                return "Open the Android applications settings";
            case "android.action.open_app_info":
                return "Open settings for this SuperAgent LAN Client only";
            case "android.action.open_date_settings":
                return "Open date and time settings";
            default:
                throw new SecurityException("Unsupported Android action");
        }
    }

    public static boolean isVolumeAction(String command) {
        return "android.action.volume_up".equals(command)
                || "android.action.volume_down".equals(command);
    }

    public static void adjustMediaVolume(Context context, String command) {
        if (!isVolumeAction(command)) throw new SecurityException("Audio action not allowlisted.");
        AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (audio == null) throw new IllegalStateException("Audio service unavailable.");
        audio.adjustStreamVolume(AudioManager.STREAM_MUSIC,
                "android.action.volume_up".equals(command)
                        ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER,
                AudioManager.FLAG_SHOW_UI);
    }

    public static Intent intent(Context context, String command) {
        if (isVolumeAction(command)) {
            throw new SecurityException("Audio action must be handled locally, not through an Intent.");
        }
        final Intent intent;
        switch (command) {
            case "android.action.open_wifi_settings":
                intent = new Intent(Settings.ACTION_WIFI_SETTINGS);
                break;
            case "android.action.open_bluetooth_settings":
                intent = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS);
                break;
            case "android.action.open_display_settings":
                intent = new Intent(Settings.ACTION_DISPLAY_SETTINGS);
                break;
            case "android.action.open_battery_settings":
                intent = new Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS);
                break;
            case "android.action.open_storage_settings":
                intent = new Intent(Settings.ACTION_INTERNAL_STORAGE_SETTINGS);
                break;
            case "android.action.open_app_settings":
                intent = new Intent(Settings.ACTION_APPLICATION_SETTINGS);
                break;
            case "android.action.open_app_info":
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.parse("package:" + context.getPackageName()));
                break;
            case "android.action.open_date_settings":
                intent = new Intent(Settings.ACTION_DATE_SETTINGS);
                break;
            default:
                throw new SecurityException("Unsupported Android action");
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }
}
