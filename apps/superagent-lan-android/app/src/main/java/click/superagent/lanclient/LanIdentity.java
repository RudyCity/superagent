package click.superagent.lanclient;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.math.BigInteger;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Date;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.security.auth.x500.X500Principal;

/**
 * Generates the target's private RSA key INSIDE Android Keystore, not in APK assets.
 * TLS 1.3 server certificate is self-signed and must be explicitly pinned
 * by comparing all 64 hex digits displayed on this phone.
 */
public final class LanIdentity {
    private static final String ALIAS = "superagent_lan_android_tls_v1";
    private LanIdentity() {}

    public static final class ServerIdentity {
        public final SSLContext tls;
        public final String fingerprint;

        ServerIdentity(SSLContext tls, String fingerprint) {
            this.tls = tls;
            this.fingerprint = fingerprint;
        }
    }

    public static ServerIdentity getOrCreate() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) {
            X509Certificate existing = (X509Certificate) store.getCertificate(ALIAS);
            if (existing == null || existing.getNotAfter().before(new Date())) {
                store.deleteEntry(ALIAS);
            }
        }
        if (!store.containsAlias(ALIAS)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(
                    KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore");
            long now = System.currentTimeMillis();
            KeyGenParameterSpec settings = new KeyGenParameterSpec.Builder(
                    ALIAS, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                    .setKeySize(2048)
                    .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA384)
                    .setSignaturePaddings(
                            KeyProperties.SIGNATURE_PADDING_RSA_PSS,
                            KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                    .setCertificateSubject(new X500Principal("CN=SuperAgent Android LAN Client"))
                    .setCertificateSerialNumber(new BigInteger(64, new SecureRandom()).abs().add(BigInteger.ONE))
                    .setCertificateNotBefore(new Date(now - 60_000))
                    .setCertificateNotAfter(new Date(now + 365L * 24 * 60 * 60 * 1000))
                    .build();
            generator.initialize(settings);
            generator.generateKeyPair();
            store.load(null);
        }
        X509Certificate cert = (X509Certificate) store.getCertificate(ALIAS);
        if (cert == null) throw new IllegalStateException("No AndroidKeystore TLS certificate available.");
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
        StringBuilder fingerprint = new StringBuilder(64);
        for (byte value : hash) fingerprint.append(String.format(java.util.Locale.US, "%02x", value & 0xff));

        KeyManagerFactory keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        keys.init(store, null);
        SSLContext tls = SSLContext.getInstance("TLSv1.3");
        tls.init(keys.getKeyManagers(), null, new SecureRandom());
        return new ServerIdentity(tls, fingerprint.toString());
    }
}
