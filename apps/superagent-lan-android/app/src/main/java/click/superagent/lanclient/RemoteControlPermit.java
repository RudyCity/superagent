package click.superagent.lanclient;

/**
 * Fail-closed, memory-only authorization gates for interactive screen control.
 * Accessibility may remain OS-enabled but cannot inject input unless all three
 * independent, transient conditions are true. No persistence or autostart.
 */
public final class RemoteControlPermit {
    private static volatile boolean approvedSession;
    private static volatile boolean screenCaptureActive;
    private static volatile boolean userEnabledInput;
    private RemoteControlPermit() {}

    public static synchronized void session(boolean active) {
        approvedSession = active;
        if (!active) userEnabledInput = false;
    }

    public static synchronized void projection(boolean active) {
        screenCaptureActive = active;
        if (!active) userEnabledInput = false;
    }

    public static synchronized void inputConsent(boolean enabled) {
        userEnabledInput = enabled && screenCaptureActive && approvedSession;
    }

    public static boolean hasApprovedSession() { return approvedSession; }

    public static boolean canView() {
        return approvedSession && screenCaptureActive;
    }

    public static boolean canControl() {
        return canView() && userEnabledInput;
    }

    public static synchronized void revoke() {
        approvedSession = false;
        screenCaptureActive = false;
        userEnabledInput = false;
    }
}
