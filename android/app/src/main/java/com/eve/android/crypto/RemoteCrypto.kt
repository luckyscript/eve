package com.eve.android.crypto

import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object RemoteCrypto {
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    fun encode(bytes: ByteArray): String = encoder.encodeToString(bytes)
    fun decode(text: String): ByteArray {
        require(text.length <= 720_000 && text.matches(Regex("[A-Za-z0-9_-]+"))) { "无效 base64url" }
        return Base64.getUrlDecoder().decode(text).also { require(encode(it) == text) { "非规范 base64url" } }
    }
    fun nonce(): ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) }
    fun hmac(key: ByteArray, data: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256")); doFinal(data)
    }
    fun proof(secret: ByteArray, direction: String, pairId: String, clientId: String, clientNonce: String, serverNonce: String): String {
        require(secret.size == 32 && direction in setOf("server", "client"))
        return encode(hmac(secret, "eve-relay-v1\n$direction\n$pairId\n$clientId\n$clientNonce\n$serverNonce".toByteArray(Charsets.UTF_8)))
    }
    fun verify(expected: String, actual: String): Boolean = runCatching {
        MessageDigest.isEqual(decode(expected), decode(actual))
    }.getOrDefault(false)
    fun derive(secret: ByteArray, clientNonce: ByteArray, serverNonce: ByteArray, direction: String): ByteArray {
        require(secret.size == 32 && clientNonce.size == 32 && serverNonce.size == 32)
        require(direction in setOf("c2s", "s2c"))
        val prk = hmac(clientNonce + serverNonce, secret)
        return hmac(prk, "eve-relay-v1:$direction".toByteArray(Charsets.UTF_8) + byteArrayOf(1))
    }
    fun crypt(encrypt: Boolean, key: ByteArray, direction: String, seq: Long, input: ByteArray): ByteArray {
        require(seq in 1..2147483647L && key.size == 32 && direction in setOf("c2s", "s2c"))
        val nonce = ByteBuffer.allocate(12).putInt(0).putLong(seq).array()
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(if (encrypt) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            updateAAD("eve-relay-v1\n$direction\n$seq".toByteArray(Charsets.UTF_8))
            doFinal(input)
        }
    }
}

/** A new instance is mandatory for each socket; counters advance only after valid tags. */
class CryptoSession(secret: ByteArray, clientNonce: ByteArray, serverNonce: ByteArray) {
    private val outgoing = RemoteCrypto.derive(secret, clientNonce, serverNonce, "c2s")
    private val incoming = RemoteCrypto.derive(secret, clientNonce, serverNonce, "s2c")
    private var sent = 0L
    private var received = 0L
    fun encrypt(plain: ByteArray): Pair<Long, String> {
        require(plain.size <= 64 * 1024) { "请求超过 64 KiB" }
        val seq = sent + 1
        val data = RemoteCrypto.encode(RemoteCrypto.crypt(true, outgoing, "c2s", seq, plain))
        sent = seq
        return seq to data
    }
    fun decrypt(seq: Long, data: String): ByteArray {
        require(seq == received + 1) { "消息顺序无效（重放或缺口）" }
        val decoded = RemoteCrypto.decode(data)
        require(decoded.size <= 384 * 1024 && decoded.size >= 16) { "消息大小无效" }
        return RemoteCrypto.crypt(false, incoming, "s2c", seq, decoded).also { received = seq }
    }
}
