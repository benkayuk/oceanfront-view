package ai.sunnypilot.webhud

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class SshWireTest {
    private val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private val pub = pair.public as ECPublicKey

    private fun DataInputStream.string(): ByteArray = ByteArray(readInt()).also { readFully(it) }

    @Test
    fun publicKeyBlobIsTheRfc5656Layout() {
        val blob = SshWire.ecdsaPublicBlob(pub)
        val r = DataInputStream(ByteArrayInputStream(blob))
        assertEquals("ecdsa-sha2-nistp256", String(r.string()))
        assertEquals("nistp256", String(r.string()))
        val q = r.string()
        assertEquals(65, q.size)
        assertEquals(4, q[0].toInt())
        assertEquals(pub.w.affineX, BigInteger(1, q.copyOfRange(1, 33)))
        assertEquals(pub.w.affineY, BigInteger(1, q.copyOfRange(33, 65)))
        assertEquals(0, r.available())
    }

    @Test
    fun openSshLineAndFingerprint() {
        val line = SshWire.openSshLine(pub, "oceanfront-view")
        val parts = line.split(' ')
        assertEquals("ecdsa-sha2-nistp256", parts[0])
        assertArrayEquals(SshWire.ecdsaPublicBlob(pub), Base64.getDecoder().decode(parts[1]))
        assertEquals("oceanfront-view", parts[2])
        val fp = SshWire.fingerprint(SshWire.ecdsaPublicBlob(pub))
        assertTrue(fp.startsWith("SHA256:") && !fp.endsWith("="))
        assertEquals(43, fp.removePrefix("SHA256:").length)
    }

    @Test
    fun signatureBlobCarriesRAndSOfTheDerSignature() {
        val data = "session id + request".toByteArray()
        repeat(20) {   // r and s with and without the high bit set
            val der = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(data); sign() }
            val (r0, s0) = SshWire.derToRs(der)
            val blob = SshWire.ecdsaSignatureBlob(der)
            val rd = DataInputStream(ByteArrayInputStream(blob))
            assertEquals("ecdsa-sha2-nistp256", String(rd.string()))
            val inner = DataInputStream(ByteArrayInputStream(rd.string()))
            val r = BigInteger(inner.string())
            val s = BigInteger(inner.string())
            assertEquals(r0, r)
            assertEquals(s0, s)
            assertTrue(r.signum() > 0 && s.signum() > 0)
        }
    }

    @Test
    fun shellQuoteSurvivesQuotes() {
        assertEquals("'it'\\''s'", CommaManager.shellQuote("it's"))
        assertEquals("''", CommaManager.shellQuote(""))
    }
}
