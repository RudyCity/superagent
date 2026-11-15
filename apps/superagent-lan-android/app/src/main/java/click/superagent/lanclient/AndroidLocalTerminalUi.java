package click.superagent.lanclient;

import android.app.Activity;
import android.graphics.Typeface;
import android.text.InputFilter;
import android.text.InputType;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Local foreground-only terminal: uses the Android app UID, never root, ADB or remote RPC.
 * On TV, commands may be typed with a Bluetooth keyboard or the TV keyboard.
 */
final class AndroidLocalTerminalUi {
    private final Activity activity;
    private final LocalAndroidShell shell;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final TextView output;
    private final EditText input;
    private final Button run;
    private final Button stop;
    private boolean closed;
    private boolean busy;

    AndroidLocalTerminalUi(Activity activity, LinearLayout page) {
        this.activity = activity;
        shell = new LocalAndroidShell(activity);
        AndroidUiKit.add(page, AndroidUiKit.text(activity, "Android terminal", 24,
                AndroidUiKit.TEXT, true), 0);
        AndroidUiKit.add(page, AndroidUiKit.text(activity,
                "LOCAL DEVICE ONLY · Commands run as this app, not as root or on the Windows PC. "
                + "Only commands you type here are executed. Nothing is accepted from connected controllers.",
                14, AndroidUiKit.MUTED, false), 6);
        LinearLayout panel = AndroidUiKit.panel(page, "ON-DEVICE SHELL");
        output = AndroidUiKit.text(activity,
                "Ready. Try: pwd, id, getprop ro.product.model or ls\n"
                + "Commands have a 10-second limit and output is capped at 24 KiB.",
                14, AndroidUiKit.ACCENT, false);
        output.setTypeface(Typeface.MONOSPACE);
        output.setTextIsSelectable(true);
        AndroidUiKit.add(panel, output, 6);
        input = new EditText(activity);
        input.setHint("Android shell command");
        input.setSingleLine(true);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setFilters(new InputFilter[] { new InputFilter.LengthFilter(512) });
        AndroidUiKit.field(input);
        AndroidUiKit.add(panel, input, 14);
        run = AndroidUiKit.button(activity, "Run on this Android device", this::execute);
        AndroidUiKit.primary(run);
        AndroidUiKit.add(panel, run, 10);
        stop = AndroidUiKit.button(activity, "Stop running command", this::cancel);
        stop.setEnabled(false);
        AndroidUiKit.add(panel, stop, 7);
        Button clear = AndroidUiKit.button(activity, "Clear local output", () ->
                output.setText("Output cleared. No command history is saved."));
        AndroidUiKit.add(panel, clear, 7);
        input.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId != EditorInfo.IME_ACTION_GO) return false;
            execute();
            return true;
        });
    }

    private void execute() {
        if (closed || busy) return;
        if (RemoteControlPermit.hasApprovedSession() || ScreenProjectionService.isActive()) {
            output.setText("Terminal locked during an approved support or screen-sharing session. Stop all sharing before running local commands.");
            return;
        }
        String command = input.getText().toString().trim();
        if (command.isEmpty()) {
            input.setError("Enter a command");
            return;
        }
        busy = true;
        run.setEnabled(false);
        stop.setEnabled(true);
        output.setText("$ " + command + "\nRunning locally...");
        shell.prepare();
        executor.execute(() -> {
            String result = shell.execute(command);
            activity.runOnUiThread(() -> {
                if (closed) return;
                output.setText("$ " + command + "\n" + result);
                busy = false;
                run.setEnabled(true);
                stop.setEnabled(false);
            });
        });
    }

    private void cancel() { shell.stop(); }

    void stopRunningCommand() { shell.stop(); }

    void close() {
        closed = true;
        shell.close();
        executor.shutdownNow();
    }
}
