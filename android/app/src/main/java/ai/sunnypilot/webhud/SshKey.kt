package ai.sunnypilot.webhud

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.jcraft.jsch.Identity
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/**
 * The app's SSH key for the comma: an ECDSA P-256 key pair made in the Android Keystore, so the private key
 * never leaves it (it signs there, and can't be read out even with root). The public half goes onto the comma
 * through its bridge (`POST /api/ssh/authorize`, which adds it to openpilot's `GithubSshKeys`), and the
 * comma's sshd lets the app in as `comma` with it ([CommaSsh]).
 */
class SshKey(context: Context) {
    private val prefs = context.getSharedPreferences("comma", Context.MODE_PRIVATE)

    private fun store(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    val exists: Boolean get() = runCatching { store().containsAlias(ALIAS) }.getOrDefault(false)

    /** When the key was made (ms since the epoch), or 0. */
    val created: Long get() = prefs.getLong(PREF_CREATED, 0)

    /** Makes the key pair if there isn't one. */
    @Synchronized
    fun create() {
        if (exists) return
        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)
        kpg.initialize(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
        )
        kpg.generateKeyPair()
        prefs.edit().putLong(PREF_CREATED, System.currentTimeMillis()).apply()
    }

    @Synchronized
    fun delete() {
        runCatching { store().deleteEntry(ALIAS) }
        prefs.edit().remove(PREF_CREATED).apply()
    }

    fun publicKey(): ECPublicKey? = runCatching { store().getCertificate(ALIAS)?.publicKey as? ECPublicKey }.getOrNull()

    /** The `authorized_keys` line: "ecdsa-sha2-nistp256 AAAA... comment", or null without a key. */
    fun openSsh(): String? = publicKey()?.let { SshWire.openSshLine(it, COMMENT) }

    fun fingerprint(): String? = publicKey()?.let { SshWire.fingerprint(SshWire.ecdsaPublicBlob(it)) }

    /** The key as JSch takes it: it signs in the Keystore. */
    fun identity(): Identity {
        val pub = publicKey() ?: throw IllegalStateException("no SSH key yet")
        val priv = store().getKey(ALIAS, null) as PrivateKey
        val blob = SshWire.ecdsaPublicBlob(pub)
        return object : Identity {
            override fun setPassphrase(passphrase: ByteArray?) = true
            override fun getPublicKeyBlob() = blob
            override fun getSignature(data: ByteArray): ByteArray {
                val s = Signature.getInstance("SHA256withECDSA")
                s.initSign(priv)
                s.update(data)
                return SshWire.ecdsaSignatureBlob(s.sign())
            }
            override fun getSignature(data: ByteArray, alg: String) = getSignature(data)
            override fun getAlgName() = SshWire.ECDSA
            override fun getName() = COMMENT
            override fun isEncrypted() = false
            override fun clear() {}
        }
    }

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "comma-ssh"
        private const val PREF_CREATED = "keyCreated"
        const val COMMENT = "oceanfront-view"
    }
}

/** The SSH wire format of an ECDSA P-256 key and its signatures (RFC 4251, 5656), and OpenSSH's text forms. */
object SshWire {
    const val ECDSA = "ecdsa-sha2-nistp256"
    private const val CURVE = "nistp256"

    private fun ByteArrayOutputStream.u32(n: Int) {
        write(n ushr 24); write(n ushr 16); write(n ushr 8); write(n)
    }

    private fun ByteArrayOutputStream.string(b: ByteArray) {
        u32(b.size); write(b)
    }

    /** A 32-byte big-endian coordinate. */
    private fun fixed32(v: BigInteger): ByteArray {
        val b = v.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)   // a leading sign byte
            else -> ByteArray(32 - b.size) + b
        }
    }

    fun ecdsaPublicBlob(pub: ECPublicKey): ByteArray {
        val q = byteArrayOf(4) + fixed32(pub.w.affineX) + fixed32(pub.w.affineY)
        return ByteArrayOutputStream().apply {
            string(ECDSA.toByteArray())
            string(CURVE.toByteArray())
            string(q)
        }.toByteArray()
    }

    fun openSshLine(pub: ECPublicKey, comment: String): String =
        "$ECDSA ${Base64.getEncoder().encodeToString(ecdsaPublicBlob(pub))} $comment"

    /** OpenSSH's "SHA256:..." fingerprint of a public key blob. */
    fun fingerprint(blob: ByteArray): String =
        "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(blob))

    /** The (r, s) of a DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }). */
    fun derToRs(der: ByteArray): Pair<BigInteger, BigInteger> {
        var i = 0
        fun len(): Int {
            val b = der[i++].toInt() and 0xFF
            if (b < 0x80) return b
            var n = 0
            repeat(b and 0x7F) { n = (n shl 8) or (der[i++].toInt() and 0xFF) }
            return n
        }
        fun int(): BigInteger {
            require(der[i++].toInt() == 0x02) { "not a DER INTEGER" }
            val n = len()
            return BigInteger(der.copyOfRange(i, i + n)).also { i += n }
        }
        require(der[i++].toInt() == 0x30) { "not a DER SEQUENCE" }
        len()
        return int() to int()
    }

    /** An SSH "ecdsa-sha2-nistp256" signature blob from a DER one: string(alg) string(mpint r, mpint s). */
    fun ecdsaSignatureBlob(der: ByteArray): ByteArray {
        val (r, s) = derToRs(der)
        val inner = ByteArrayOutputStream().apply {
            string(r.toByteArray())   // mpint: two's complement, the leading zero kept for a high bit
            string(s.toByteArray())
        }.toByteArray()
        return ByteArrayOutputStream().apply {
            string(ECDSA.toByteArray())
            string(inner)
        }.toByteArray()
    }
}
