package click.superagent.lanclient;

/** Plain JVM unit checks for the Android target's strict private IPv4 policy. */
public final class LanPolicyChecks {
    private static int cases;

    private static void check(boolean condition, String message) {
        cases++;
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        check(LanPolicy.isPrivate("192.168.1.12"), "192.168 private");
        check(LanPolicy.isPrivate("10.2.3.4"), "10/8 private");
        check(LanPolicy.isPrivate("172.16.9.2"), "172.16 private");
        check(LanPolicy.isPrivate("172.31.255.250"), "172.31 private");
        for (String ip : new String[] {
                "127.0.0.1", "0.0.0.0", "8.8.8.8", "172.32.1.1",
                "192.168.1.999", "192.168.01.3", "224.0.0.1",
                "::1", "192.168.1.", "192.168.1.3.extra", " 10.1.1.1"
        }) check(!LanPolicy.isPrivate(ip), "reject non-private or malformed IP: " + ip);
        check(LanPolicy.sameSubnet("192.168.0.9", 24, "192.168.0.155"), "same /24");
        check(!LanPolicy.sameSubnet("192.168.0.9", 24, "192.168.1.2"), "cross /24");
        check(LanPolicy.sameSubnet("10.0.0.2", 8, "10.19.20.30"), "same /8");
        check(!LanPolicy.sameSubnet("10.0.0.2", 8, "192.168.3.4"), "cross /8");
        check(!LanPolicy.sameSubnet("192.168.1.4", 31, "192.168.1.5"), "too narrow");
        check(!LanPolicy.sameSubnet("192.168.1.4", 0, "192.168.1.5"), "wildcard");
        check(!LanPolicy.sameSubnet("192.168.1.4", 24, "127.0.0.1"), "loopback peer");
        check(LanPolicy.privateIntranetPeer("10.200.4.187", "10.200.84.27"), "routed campus /16");
        check(!LanPolicy.privateIntranetPeer("10.200.4.187", "10.201.84.27"), "different private /16");
        check(!LanPolicy.privateIntranetPeer("10.200.4.187", "127.0.0.1"), "loopback denied");
        check(!LanPolicy.privateIntranetPeer("10.200.4.187", "8.8.8.8"), "public denied");
        check(!LanPolicy.privateIntranetPeer("10.200.4.187", "10.200.04.27"), "ambiguous IPv4 denied");
        System.out.println("ANDROID_LAN_POLICY_PASS " + cases + " checks");
    }
}
