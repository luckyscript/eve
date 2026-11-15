package com.eve.android.pairing

import com.eve.android.crypto.RemoteCrypto
import java.net.URI
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class Invite(val v: Int, val relayUrl: String, val routingToken: String, val pairId: String,
                  val secret: String, val expiresAt: Long, val desktopName: String)

object Pairing {
    private val json = Json { ignoreUnknownKeys = false }
    fun parse(uri: String, development: Boolean, now: Long = System.currentTimeMillis()): Invite {
        require(uri.length in 1..8192) { "配对链接过长或为空" }
        val parsed = runCatching { URI(uri.trim()) }.getOrElse { error("配对链接格式无效") }
        require(parsed.scheme == "eve" && parsed.host == "pair" && parsed.userInfo == null && parsed.port == -1 &&
            parsed.rawFragment == null && parsed.rawPath.orEmpty().isEmpty()) { "请使用 eve://pair?data=… 链接" }
        val query = parsed.rawQuery.orEmpty()
        require(query.startsWith("data=") && !query.contains('&')) { "配对数据格式无效" }
        val invite = runCatching {
            val payload = RemoteCrypto.decode(query.removePrefix("data="))
            json.decodeFromString<Invite>(payload.toString(Charsets.UTF_8))
        }.getOrElse { error("无法解析配对数据") }
        validate(invite, development, imported = true, now = now)
        return invite
    }
    fun validate(invite: Invite, development: Boolean, imported: Boolean, now: Long = System.currentTimeMillis()) {
        require(invite.v == 1) { "不支持此协议版本" }
        require(runCatching { UUID.fromString(invite.pairId).toString() == invite.pairId.lowercase() }.getOrDefault(false)) { "配对 ID 无效" }
        require(invite.routingToken.length in 16..256 && invite.routingToken.matches(Regex("[A-Za-z0-9_-]+"))) { "路由 token 无效" }
        require(runCatching { RemoteCrypto.decode(invite.secret).size == 32 }.getOrDefault(false)) { "配对密钥必须为 32 字节" }
        require(invite.desktopName.length in 1..128 && invite.desktopName.none { it.isISOControl() }) { "电脑名称无效" }
        require(invite.expiresAt > 0 && (!imported || invite.expiresAt > now)) { "配对邀请已过期，请在电脑重新生成" }
        relay(invite.relayUrl, development)
    }
    fun relay(url: String, development: Boolean): URI {
        require(url.length in 1..2048) { "relay 地址无效" }
        val u = runCatching { URI(url) }.getOrElse { error("relay 地址无效") }
        require(u.scheme in setOf("https", "wss", "http", "ws") && !u.host.isNullOrBlank() &&
            u.userInfo == null && u.rawQuery == null && u.rawFragment == null && u.rawPath.orEmpty() in setOf("", "/") &&
            (u.port == -1 || u.port in 1..65535)) { "relay 必须是无路径、无账号的安全地址" }
        val loopback = u.host.lowercase() in setOf("localhost", "127.0.0.1", "[::1]", "::1")
        require(u.scheme in setOf("https", "wss") || (development && loopback)) { "非本机 relay 必须使用 HTTPS/WSS" }
        return u
    }
    fun socketUrl(invite: Invite, development: Boolean): String {
        val u = relay(invite.relayUrl, development)
        val scheme = if (u.scheme in setOf("https", "wss")) "wss" else "ws"
        return "$scheme://${u.rawAuthority}/c/${invite.routingToken}/__eve_remote__"
    }
}
