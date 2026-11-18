package click.superagent.lanclient;

import android.app.Activity;
import android.graphics.Typeface;
import android.text.InputFilter;
import android.text.InputType;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
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
    private final TextView status;
    private final ScrollView consoleScroll;
    private final EditText input;
    private final Button run;
    private final Button stop;
    private boolean closed;
    private boolean busy;

    AndroidLocalTerminalUi(Activity activity, LinearLayout page) {
        this.activity = activity;
        shell = new LocalAndroidShell(activity);
        AndroidUiKit.add(page, AndroidUiKit.text(activity, "On-Device Shell", 24,
                AndroidUiKit.TEXT, true), 0);
        AndroidUiKit.add(page, AndroidUiKit.text(activity,
                "Commands execute locally under app UID. Zero root or cloud telemetry.",
                13, AndroidUiKit.TEXT_MUTED, false), 2);
        LinearLayout panel = AndroidUiKit.panel(page, "CONSOLE OUTPUT");
        output = AndroidUiKit.text(activity,
                "Ready. Try: pwd, id, getprop ro.product.model or ls\n"
                + "Limit: 10s timeout, 24 KiB output.",
                13, AndroidUiKit.ACCENT, false);
        output.setTypeface(Typeface.MONOSPACE);
        output.setTextIsSelectable(true);
        output.setPadding(AndroidUiKit.dp(activity, 12), AndroidUiKit.dp(activity, 10),
                AndroidUiKit.dp(activity, 12), AndroidUiKit.dp(activity, 10));
        output.setBackground(AndroidUiKit.shape(AndroidUiKit.SURFACE_INSET, AndroidUiKit.LINE_SUBTLE, 12, activity));
        consoleScroll = new ScrollView(activity);
        consoleScroll.setFillViewport(false);
        consoleScroll.setFocusable(true);
        consoleScroll.setVerticalScrollBarEnabled(false);
        consoleScroll.addView(output);
        LinearLayout.LayoutParams viewport = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, AndroidUiKit.dp(activity, 220));
        viewport.topMargin = AndroidUiKit.dp(activity, 6);
        panel.addView(consoleScroll, viewport);
        status = AndroidUiKit.text(activity, "Idle · no command running", 12,
                AndroidUiKit.TEXT_MUTED, false);
        AndroidUiKit.add(panel, status, 8);
        input = new EditText(activity);
        input.setHint("Enter shell command...");
        input.setSingleLine(true);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setFilters(new InputFilter[] { new InputFilter.LengthFilter(512) });
        AndroidUiKit.field(input);
        AndroidUiKit.add(panel, input, 12);
        LinearLayout actionRow = AndroidUiKit.row(activity);
        run = AndroidUiKit.button(activity, "Run", this::execute);
        AndroidUiKit.primary(run);
        AndroidUiKit.addToRow(actionRow, run, 1.2f);
        stop = AndroidUiKit.button(activity, "Stop", this::cancel);
        AndroidUiKit.destructive(stop);
        stop.setEnabled(false);
        AndroidUiKit.addToRow(actionRow, stop, 1.0f);
        Button clear = AndroidUiKit.button(activity, "Clear", () ->
                output.setText("Console cleared."));
        AndroidUiKit.addToRow(actionRow, clear, 1.0f);
        AndroidUiKit.add(panel, actionRow, 10);
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
        status.setText("Running · max 10 seconds · app sandbox");
        consoleScroll.post(() -> consoleScroll.fullScroll(ScrollView.FOCUS_DOWN));
        shell.prepare();
        executor.execute(() -> {
            String result = shell.execute(command);
            activity.runOnUiThread(() -> {
                if (closed) return;
                output.setText("$ " + command + "\n" + result);
                int code = shell.exitCode();
                status.setText(code >= 0 ? "Finished · exit code " + code : "Stopped, timed out or unavailable");
                consoleScroll.post(() -> consoleScroll.fullScroll(ScrollView.FOCUS_DOWN));
                busy = false;
                run.setEnabled(true);
                stop.setEnabled(false);
            });
        });
    }

    private void cancel() {
        if (!busy || closed) return;
        status.setText("Stopping command...");
        stop.setEnabled(false);
        shell.stop();
    }

    void stopRunningCommand() { shell.stop(); }

    void close() {
        closed = true;
        shell.close();
        executor.shutdownNow();
    }
}
