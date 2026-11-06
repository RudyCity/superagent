package click.superagent.lanclient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;

/**
 * Creates an ephemeral software EC P-256 TLS identity for each LAN sharing
 * lifetime. Some Android vendor Keymaster implementations reject Conscrypt's
 * raw RSA/ECDSA handshake operations even for otherwise valid Keystore keys.
 *
 * The private key exists only in process memory and is never persisted or
 * exported. The self-signed certificate is still authenticated by requiring
 * the controller to compare/pin its complete SHA-256 fingerprint before it
 * sends the one-time pairing code.
 */
public final class LanIdentity {
    private static final SecureRandom RANDOM = new SecureRandom();
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
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"), RANDOM);
        KeyPair pair = generator.generateKeyPair();
        X509Certificate cert = selfSigned(pair);

        char[] password = randomPassword();
        KeyStore store = KeyStore.getInstance("PKCS12");
        store.load(null, password);
        store.setKeyEntry("superagent-lan", pair.getPrivate(), password,
                new Certificate[] { cert });

        KeyManagerFactory keys = KeyManagerFactory.getInstance(
                KeyManagerFactory.getDefaultAlgorithm());
        keys.init(store, password);
        java.util.Arrays.fill(password, '\0');

        SSLContext tls = SSLContext.getInstance("TLSv1.3");
        tls.init(keys.getKeyManagers(), null, RANDOM);
        return new ServerIdentity(tls, sha256(cert.getEncoded()));
    }

    private static char[] randomPassword() {
        byte[] bytes = new byte[24];
        RANDOM.nextBytes(bytes);
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) value.append(String.format(Locale.US, "%02x", b & 0xff));
        java.util.Arrays.fill(bytes, (byte) 0);
        return value.toString().toCharArray();
    }

    private static X509Certificate selfSigned(KeyPair pair) throws Exception {
        long now = System.currentTimeMillis();
        byte[] algorithm = sequence(oid(new int[] {1, 2, 840, 10045, 4, 3, 2}));
        byte[] name = sequence(set(sequence(
                oid(new int[] {2, 5, 4, 3}),
                utf8("SuperAgent Android LAN Client"))));
        byte[] validity = sequence(
                generalizedTime(new Date(now - 60_000L)),
                generalizedTime(new Date(now + 24L * 60 * 60 * 1000)));
        byte[] tbs = sequence(
                tagged(0xa0, integer(BigInteger.valueOf(2))),
                integer(new BigInteger(120, RANDOM).abs().add(BigInteger.ONE)),
                algorithm,
                name,
                validity,
                name,
                pair.getPublic().getEncoded());

        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(pair.getPrivate(), RANDOM);
        signer.update(tbs);
        byte[] signature = signer.sign();

        byte[] encoded = sequence(tbs, algorithm, bitString(signature));
        X509Certificate cert = (X509Certificate) CertificateFactory.getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(encoded));
        cert.checkValidity(new Date(now));
        cert.verify(pair.getPublic());
        return cert;
    }

    private static String sha256(byte[] bytes) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder out = new StringBuilder(64);
        for (byte value : hash) out.append(String.format(Locale.US, "%02x", value & 0xff));
        return out.toString();
    }

    private static byte[] generalizedTime(Date value) {
        SimpleDateFormat format = new SimpleDateFormat("yyyyMMddHHmmss'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return tagged(0x18, format.format(value).getBytes(StandardCharsets.US_ASCII));
    }

    private static byte[] utf8(String value) {
        return tagged(0x0c, value.getBytes(StandardCharsets.UTF_8));
    }

    private static byte[] integer(BigInteger value) {
        return tagged(0x02, value.toByteArray());
    }

    private static byte[] bitString(byte[] value) {
        byte[] bits = new byte[value.length + 1];
        System.arraycopy(value, 0, bits, 1, value.length);
        return tagged(0x03, bits);
    }

    private static byte[] oid(int[] components) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        body.write(components[0] * 40 + components[1]);
        for (int i = 2; i < components.length; i++) {
            long value = components[i];
            int count = 1;
            long cursor = value;
            while ((cursor >>>= 7) != 0) count++;
            for (int shift = (count - 1) * 7; shift >= 0; shift -= 7) {
                int next = (int) ((value >>> shift) & 0x7f);
                if (shift != 0) next |= 0x80;
                body.write(next);
            }
        }
        return tagged(0x06, body.toByteArray());
    }

    private static byte[] sequence(byte[]... values) {
        return tagged(0x30, join(values));
    }

    private static byte[] set(byte[]... values) {
        return tagged(0x31, join(values));
    }

    private static byte[] join(byte[]... values) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] value : values) out.write(value, 0, value.length);
        return out.toByteArray();
    }

    private static byte[] tagged(int tag, byte[] value) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(tag);
        writeLength(out, value.length);
        out.write(value, 0, value.length);
        return out.toByteArray();
    }

    private static void writeLength(ByteArrayOutputStream out, int length) {
        if (length < 128) {
            out.write(length);
            return;
        }
        int bytes = 0;
        int value = length;
        while (value != 0) { bytes++; value >>>= 8; }
        out.write(0x80 | bytes);
        for (int shift = (bytes - 1) * 8; shift >= 0; shift -= 8)
            out.write((length >>> shift) & 0xff);
    }
}
