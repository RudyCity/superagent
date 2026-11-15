package click.superagent.lanclient;

import android.content.Context;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * App-sandbox Android shell. Agent access is separately gated in LanClientServer
 * and needs physical owner approval for every command; it is never privileged.
 */
final class LocalAndroidShell {
    private static final int MAX_OUTPUT = 24 * 1024;
    private final Context app;
    private volatile Process running;
    private final AtomicBoolean stopRequested = new AtomicBoolean(false);
    private volatile boolean closed;
    private volatile int lastExitCode = -1;

    LocalAndroidShell(Context context) {
        app = context.getApplicationContext();
    }

    void prepare() {
        lastExitCode = -1;
        if (!closed) stopRequested.set(false);
    }

    int exitCode() { return lastExitCode; }

    String execute(String command) {
        if (closed || stopRequested.get()) return "Command cancelled.";
        if (command == null || command.trim().isEmpty() || command.length() > 512)
            return "Enter a command of at most 512 characters.";
        File log = null;
        Process current = null;
        try {
            log = File.createTempFile("terminal-", ".tmp", app.getCacheDir());
            ProcessBuilder builder = new ProcessBuilder("/system/bin/sh", "-c", command);
            builder.directory(app.getFilesDir());
            builder.redirectErrorStream(true);
            builder.redirectOutput(log);
            current = builder.start();
            running = current;
            if (closed || stopRequested.get()) current.destroyForcibly();
            boolean finished = current.waitFor(10, TimeUnit.SECONDS);
            if (!finished) current.destroyForcibly();
            byte[] bytes = new byte[MAX_OUTPUT];
            int length;
            try (InputStream in = new FileInputStream(log)) {
                length = in.read(bytes);
            }
            int exit = !finished || stopRequested.get() ? -1 : current.exitValue();
            lastExitCode = exit;
            String output = length <= 0 ? "" : new String(bytes, 0, length, StandardCharsets.UTF_8);
            String suffix = !finished ? "\n[Stopped: 10-second limit]"
                    : stopRequested.get() ? "\n[Stopped by owner or session revocation]"
                    : "\n[Exit " + exit + "]";
            if (log.length() > MAX_OUTPUT) suffix += "\n[Output truncated at 24 KiB]";
            return output + suffix;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            if (current != null) current.destroyForcibly();
            return "[Command interrupted]";
        } catch (Exception error) {
            if (current != null) current.destroyForcibly();
            return "[Command unavailable: " + error.getClass().getSimpleName() + "]";
        } finally {
            if (running == current) running = null;
            if (log != null && log.exists()) log.delete();
        }
    }

    void stop() {
        stopRequested.set(true);
        Process current = running;
        if (current != null) current.destroyForcibly();
    }

    void close() {
        closed = true;
        stop();
    }
}
