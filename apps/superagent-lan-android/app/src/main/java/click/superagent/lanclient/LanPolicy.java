package click.superagent.lanclient;

/** Pure, deterministic IPv4 LAN scope checks shared by discovery and TLS server. */
public final class LanPolicy {
    private LanPolicy() {}

    public static String canonicalIpv4(String raw) {
        if (raw == null) return null;
        String value = raw;
        String lower = value.toLowerCase(java.util.Locale.ROOT);
        if (lower.startsWith("::ffff:")) {
            value = value.substring(7);
        } else if (lower.startsWith("0:0:0:0:0:ffff:")) {
            value = value.substring(15);
        }
        String[] parts = value.split("\\.", -1);
        if (parts.length != 4) return null;
        StringBuilder canonical = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            if (!part.matches("(0|[1-9][0-9]{0,2})")) return null;
            int octet = Integer.parseInt(part);
            if (octet > 255) return null;
            if (i > 0) canonical.append('.');
            canonical.append(octet);
        }
        return canonical.toString();
    }

    public static long ipv4(String raw) {
        String canonical = canonicalIpv4(raw);
        if (canonical == null) return -1;
        String[] parts = canonical.split("\\.", -1);
        long value = 0;
        for (String part : parts) value = (value << 8) | Integer.parseInt(part);
        return value;
    }

    public static boolean sameIpv4(String a, String b) {
        String left = canonicalIpv4(a), right = canonicalIpv4(b);
        return left != null && left.equals(right);
    }

    public static boolean isPrivate(String ip) {
        long n = ipv4(ip);
        if (n < 0) return false;
        return (n & 0xff000000L) == 0x0a000000L
                || (n & 0xfff00000L) == 0xac100000L
                || (n & 0xffff0000L) == 0xc0a80000L;
    }

    /** Narrow routed-intranet exception for explicitly addressed private peers.
     * A /16 cap keeps a campus allocation reachable without accepting arbitrary
     * RFC1918 addresses, VPN endpoints or public hosts. Pairing still requires
     * the displayed TLS fingerprint, one-time code, and local owner approval. */
    public static boolean privateIntranetPeer(String local, String peer) {
        long a = ipv4(local), b = ipv4(peer);
        return a >= 0 && b >= 0 && isPrivate(local) && isPrivate(peer)
                && (a >>> 16) == (b >>> 16);
    }

    public static boolean sameSubnet(String local, int prefix, String peer) {
        long a = ipv4(local), b = ipv4(peer);
        if (!isPrivate(local) || !isPrivate(peer) || prefix < 8 || prefix > 30 || a < 0 || b < 0) return false;
        long mask = (0xffffffffL << (32 - prefix)) & 0xffffffffL;
        return (a & mask) == (b & mask);
    }
}
