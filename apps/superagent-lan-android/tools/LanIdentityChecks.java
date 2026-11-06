package click.superagent.lanclient;

import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

public final class LanIdentityChecks {
    private static void check(boolean condition, String label) {
        if (!condition) throw new AssertionError(label);
    }

    public static void main(String[] args) throws Exception {
        LanIdentity.ServerIdentity identity = LanIdentity.getOrCreate();
        check(identity.fingerprint.matches("[0-9a-f]{64}"), "fingerprint");
        SSLServerSocket server = (SSLServerSocket) identity.tls.getServerSocketFactory()
                .createServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress());
        server.setEnabledProtocols(new String[] {"TLSv1.3"});

        TrustManager[] trust = { new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] chain, String authType) {}
            public void checkServerTrusted(X509Certificate[] chain, String authType) {}
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        }};
        SSLContext clientContext = SSLContext.getInstance("TLSv1.3");
        clientContext.init(null, trust, new SecureRandom());

        Thread accepted = new Thread(() -> {
            try (SSLSocket peer = (SSLSocket) server.accept()) {
                peer.setEnabledProtocols(new String[] {"TLSv1.3"});
                peer.startHandshake();
                peer.getOutputStream().write('K');
                peer.getOutputStream().flush();
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        });
        accepted.start();
        try (SSLSocket client = (SSLSocket) clientContext.getSocketFactory()
                .createSocket(java.net.InetAddress.getLoopbackAddress(), server.getLocalPort())) {
            client.setEnabledProtocols(new String[] {"TLSv1.3"});
            client.startHandshake();
            check("TLSv1.3".equals(client.getSession().getProtocol()), "TLS 1.3");
            check(client.getInputStream().read() == 'K', "application byte");
        }
        accepted.join(5000);
        server.close();
        check(!accepted.isAlive(), "server thread");
        System.out.println("ANDROID_LAN_IDENTITY_PASS");
    }
}
