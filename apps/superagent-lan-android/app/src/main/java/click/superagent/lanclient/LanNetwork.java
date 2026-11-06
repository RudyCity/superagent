package click.superagent.lanclient;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import java.net.Inet4Address;
import java.net.InetAddress;

/** Requires an actual Android Wi-Fi/Ethernet transport, never cellular, VPN, or public routing. */
public final class LanNetwork {
    private LanNetwork() {}

    public static final class Link {
        public final String ip;
        public final int prefix;
        public final String transport;
        public final Network network;

        Link(String ip, int prefix, String transport, Network network) {
            this.ip = ip;
            this.prefix = prefix;
            this.transport = transport;
            this.network = network;
        }

        public boolean matches(Link other) {
            return other != null && ip.equals(other.ip) && prefix == other.prefix
                    && transport.equals(other.transport) && network.equals(other.network);
        }
    }

    public static Link current(Context context) {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return null;
        // Android may prefer cellular as its default even if a LAN-only Wi-Fi is connected.
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities caps = manager.getNetworkCapabilities(network);
            if (caps == null || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
            boolean wifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
            boolean ethernet = caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET);
            if (!wifi && !ethernet) continue;
            LinkProperties link = manager.getLinkProperties(network);
            if (link == null) continue;
            String interfaceName = link.getInterfaceName();
            if (interfaceName == null || interfaceName.matches("(?i).*(tun|tap|ppp|vpn|rmnet|veth|clat).*")) continue;
            for (LinkAddress address : link.getLinkAddresses()) {
                InetAddress ip = address.getAddress();
                if (!(ip instanceof Inet4Address)) continue;
                int prefix = address.getPrefixLength();
                if (prefix < 8 || prefix > 30 || !LanPolicy.isPrivate(ip.getHostAddress())) continue;
                return new Link(ip.getHostAddress(), prefix, wifi ? "Wi-Fi" : "Ethernet", network);
            }
        }
        return null;
    }

    public static boolean permitsPeer(Context context, Link startedOn, String peerIp) {
        Link now = current(context);
        return startedOn != null && startedOn.matches(now)
                && LanPolicy.privateIntranetPeer(startedOn.ip, peerIp);
    }
}
