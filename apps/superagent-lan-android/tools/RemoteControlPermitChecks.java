package click.superagent.lanclient;

/** Pure-JVM checks: Accessibility permission alone can never authorize input. */
public final class RemoteControlPermitChecks {
    private static int count;
    private static void check(boolean condition, String message) {
        count++;
        if (!condition) throw new AssertionError(message);
    }
    public static void main(String[] args) {
        RemoteControlPermit.revoke();
        check(!RemoteControlPermit.canView(), "default view must be off");
        check(!RemoteControlPermit.canControl(), "default input must be off");
        RemoteControlPermit.inputConsent(true);
        check(!RemoteControlPermit.canControl(), "input consent without session/projection denied");
        RemoteControlPermit.session(true);
        check(!RemoteControlPermit.canView(), "session alone cannot capture");
        RemoteControlPermit.inputConsent(true);
        check(!RemoteControlPermit.canControl(), "session without projection cannot inject");
        RemoteControlPermit.projection(true);
        check(RemoteControlPermit.canView(), "approved session and projection can view");
        check(!RemoteControlPermit.canControl(), "projection does not auto-enable input");
        RemoteControlPermit.inputConsent(true);
        check(RemoteControlPermit.canControl(), "explicit separate input consent works");
        RemoteControlPermit.inputConsent(false);
        check(!RemoteControlPermit.canControl(), "local input disable works");
        RemoteControlPermit.inputConsent(true);
        RemoteControlPermit.session(false);
        check(!RemoteControlPermit.canView(), "session close disables screen");
        check(!RemoteControlPermit.canControl(), "session close disables remote input");
        RemoteControlPermit.session(true);
        check(!RemoteControlPermit.canControl(), "new session must not inherit remote touch consent");
        RemoteControlPermit.inputConsent(true);
        check(RemoteControlPermit.canControl(), "new session can explicitly opt in");
        RemoteControlPermit.projection(false);
        check(!RemoteControlPermit.canView(), "capture stop disables screen");
        check(!RemoteControlPermit.canControl(), "capture stop disables input");
        RemoteControlPermit.projection(true);
        check(!RemoteControlPermit.canControl(), "new projection must not inherit input consent");
        RemoteControlPermit.inputConsent(true);
        RemoteControlPermit.revoke();
        check(!RemoteControlPermit.canView(), "revoke disables view");
        check(!RemoteControlPermit.canControl(), "revoke disables input");
        System.out.println("ANDROID_REMOTE_CONTROL_PERMIT_PASS " + count + " checks");
    }
}
