package com.kgamazing44.aerift.plugin

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Private, no-backup encrypted identity and trust records; never exposed to JS. */
internal class AndroidSecretFiles(context: Context) {
    private val root = File(context.noBackupFilesDir, "aerift-protected")
    private val alias = "aerift.identity-trust.v1"
    private val maxRecord = 1024 * 1024

    fun load(record: String): String? = synchronized(storageLock) {
        read(record)?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
    }

    fun initializeIdentity(candidate: String): String = synchronized(storageLock) {
        val existing = read("identity")
        if (existing == null) {
            write("identity", decode(candidate))
            candidate
        } else Base64.encodeToString(existing, Base64.NO_WRAP)
    }

    fun replaceTrust(value: String) = synchronized(storageLock) { write("trust", decode(value)) }

    private fun decode(encoded: String): ByteArray {
        require(encoded.length <= maxRecord * 2)
        return Base64.decode(encoded, Base64.NO_WRAP).also { require(it.size <= maxRecord) }
    }

    private fun recordFile(record: String): AtomicFile {
        require(record == "identity" || record == "trust")
        check(root.isDirectory || root.mkdirs())
        return AtomicFile(File(root, "$record.enc"))
    }

    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        // Never silently replace the key of existing encrypted records.
        check(create && root.listFiles().orEmpty().none { it.name.endsWith(".enc") || it.name.endsWith(".bak") })
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build())
            generateKey()
        }
    }

    private fun read(record: String): ByteArray? {
        val file = recordFile(record)
        val raw = try {
            file.openRead().use { input ->
                val bounded = ByteArray(maxRecord + 65)
                var count = 0
                while (count < bounded.size) {
                    val read = input.read(bounded, count, bounded.size - count)
                    if (read < 0) break
                    count += read
                }
                require(count in 30 until bounded.size)
                bounded.copyOf(count)
            }
        } catch (_: java.io.FileNotFoundException) {
            // Missing is distinct from corrupt/unreadable.
            if (listOf(file.baseFile, File(file.baseFile.path + ".bak")).any(File::exists))
                throw IllegalStateException("Protected storage unavailable")
            return null
        }
        require(raw[0] == 1.toByte() && raw[1] == 12.toByte())
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, raw.copyOfRange(2, 14)))
            updateAAD("AeRift:$record:v1".toByteArray(Charsets.UTF_8))
            doFinal(raw, 14, raw.size - 14).also { require(it.size <= maxRecord) }
        }
    }

    private fun write(record: String, raw: ByteArray) {
        val file = recordFile(record)
        val encrypted = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, key(true))
            check(iv.size == 12)
            updateAAD("AeRift:$record:v1".toByteArray(Charsets.UTF_8))
            byteArrayOf(1, 12) + iv + doFinal(raw)
        }
        val output = file.startWrite()
        try {
            output.write(encrypted)
            file.finishWrite(output)
        } catch (t: Throwable) {
            file.failWrite(output)
            throw t
        }
    }
    private companion object { val storageLock = Any() }
}
