package click.superagent.lanclient;

import android.app.Activity;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import java.util.function.Consumer;

/** Camera-only optional QR path; Android TV uses manual invitations or local pairing. */
final class AndroidQrScanner {
    private AndroidQrScanner() {}

    static boolean isConnectPayload(String raw) {
        try {
            org.json.JSONObject qr = new org.json.JSONObject(raw);
            return "sat".equals(qr.optString("k", ""))
                    || "superagent-device-tunnel".equals(qr.optString("kind", ""));
        } catch (org.json.JSONException invalidQr) {
            return false;
        }
    }

    static void scan(Activity activity, Consumer<String> accept,
                     Consumer<String> notice, Runnable complete) {
        try {
            GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
            GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(activity, options);
            notice.accept("Opening QR scanner. Scan the Connection QR in SuperAgent Tray.");
            scanner.startScan()
                    .addOnSuccessListener(barcode -> {
                        complete.run();
                        accept.accept(barcode.getRawValue());
                    })
                    .addOnCanceledListener(() -> {
                        complete.run();
                        notice.accept("QR scan cancelled. Tap Scan QR & Connect to retry.");
                    })
                    .addOnFailureListener(error -> {
                        complete.run();
                        notice.accept("QR scanner failed (" + error.getClass().getSimpleName()
                                + "). Use manual setup JSON instead.");
                    });
        } catch (Exception error) {
            complete.run();
            notice.accept("QR scanner unavailable (" + error.getClass().getSimpleName()
                    + "). Use manual setup JSON instead.");
        }
    }
}
