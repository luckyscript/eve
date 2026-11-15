package com.eve.android.transport

import com.eve.android.crypto.CryptoSession
import com.eve.android.crypto.RemoteCrypto
import com.eve.android.pairing.Invite
import com.eve.android.pairing.Pairing
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.*
import okhttp3.*
import okio.ByteString

class ProtocolFailure(val publicMessage: String) : Exception(publicMessage)

/** Single coroutine owns handshake and counters. Socket callbacks never mutate crypto state. */
class RelayTransport(private val development: Boolean) {
    private val client = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS).pingInterval(25, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build()
    private var socket: WebSocket? = null
    private var commands: Channel<JsonObject>? = null
    private sealed interface Input {
        data object Open : Input
        data class Frame(val text: String) : Input
        data class Closed(val fatal: Boolean = false) : Input
    }
    fun close() { commands?.close(); socket?.cancel(); socket = null }
    suspend fun send(payload: JsonObject) {
        val queue = commands ?: throw ProtocolFailure("电脑尚未连接")
        if (!queue.trySend(payload).isSuccess) {
            close(); throw ProtocolFailure("发送队列已满，连接已关闭；任务状态将通过原 ID 恢复")
        }
    }
    suspend fun connect(invite: Invite, clientId: String, onReady: suspend () -> Unit, onPayload: suspend (JsonObject) -> Unit) = coroutineScope {
        Pairing.validate(invite, development, imported = false)
        val input = Channel<Input>(128)
        val outbound = Channel<JsonObject>(64)
        commands = outbound
        val clientNonceBytes = RemoteCrypto.nonce()
        val clientNonce = RemoteCrypto.encode(clientNonceBytes)
        var session: CryptoSession? = null
        var authenticated = false
        var ready = false
        var overflow = false
        fun enqueue(value: Input) {
            if (!input.trySend(value).isSuccess) { overflow = true; input.close(ProtocolFailure("接收队列已满，请重新同步")); socket?.cancel() }
        }
        val ws = client.newWebSocket(Request.Builder().url(Pairing.socketUrl(invite, development)).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = enqueue(Input.Open)
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.length > 512 * 1024 || text.toByteArray().size > 512 * 1024) {
                    input.close(ProtocolFailure("电脑消息超过协议限制")); webSocket.cancel()
                } else enqueue(Input.Frame(text))
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { input.close(ProtocolFailure("不支持二进制协议帧")); webSocket.cancel() }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = enqueue(Input.Closed())
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = enqueue(Input.Closed(code == 1008))
        })
        socket = ws
        val timeout = launch { delay(15_000); if (!ready) { input.close(ProtocolFailure("握手超时，检查配对是否已撤销或 relay 是否可达")); ws.cancel() } }
        val sender = launch {
            for (payload in outbound) {
                check(ready) { "未完成握手" }
                val (seq, data) = session!!.encrypt(payload.toString().toByteArray(Charsets.UTF_8))
                if (!ws.send(buildJsonObject { put("v", 1); put("type", "encrypted"); put("seq", seq); put("data", data) }.toString())) {
                    input.close(); ws.cancel(); break
                }
            }
        }
        try {
            for (event in input) when (event) {
                Input.Open -> ws.send(buildJsonObject {
                    put("v", 1); put("type", "hello"); put("pairId", invite.pairId); put("clientId", clientId)
                    put("clientName", "Eve Android"); put("clientNonce", clientNonce)
                }.toString())
                is Input.Closed -> { if (event.fatal) throw ProtocolFailure("电脑拒绝认证或配对已撤销"); break }
                is Input.Frame -> {
                    val frame = runCatching { Json.parseToJsonElement(event.text).jsonObject }.getOrElse { throw ProtocolFailure("电脑协议格式无效") }
                    if (frame["v"]?.jsonPrimitive?.intOrNull != 1) throw ProtocolFailure("电脑协议版本不匹配")
                    when (frame["type"]?.jsonPrimitive?.content) {
                        "challenge" -> {
                            if (authenticated) throw ProtocolFailure("重复握手消息")
                            val sn = frame["serverNonce"]?.jsonPrimitive?.content ?: throw ProtocolFailure("缺少握手 nonce")
                            val sb = runCatching { RemoteCrypto.decode(sn) }.getOrElse { throw ProtocolFailure("握手 nonce 无效") }
                            if (sb.size != 32) throw ProtocolFailure("握手 nonce 长度无效")
                            val secret = RemoteCrypto.decode(invite.secret)
                            val expected = RemoteCrypto.proof(secret, "server", invite.pairId, clientId, clientNonce, sn)
                            if (!RemoteCrypto.verify(expected, frame["proof"]?.jsonPrimitive?.content.orEmpty())) throw ProtocolFailure("电脑身份验证失败：密钥不匹配或配对已撤销")
                            session = CryptoSession(secret, clientNonceBytes, sb)
                            authenticated = true
                            ws.send(buildJsonObject { put("v", 1); put("type", "authenticate"); put("proof", RemoteCrypto.proof(secret, "client", invite.pairId, clientId, clientNonce, sn)) }.toString())
                        }
                        "encrypted" -> {
                            if (!authenticated) throw ProtocolFailure("握手前收到加密消息")
                            val payload = try {
                                val seq = frame["seq"]!!.jsonPrimitive.long
                                val bytes = session!!.decrypt(seq, frame["data"]!!.jsonPrimitive.content)
                                Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
                            } catch (_: Exception) { throw ProtocolFailure("消息验证失败：密钥、顺序或认证标签无效") }
                            if (!ready) {
                                if (payload["kind"]?.jsonPrimitive?.content != "ready" || payload["clientId"]?.jsonPrimitive?.content != clientId || payload["protocol"]?.jsonPrimitive?.intOrNull != 1) throw ProtocolFailure("电脑未返回有效 ready")
                                ready = true; timeout.cancel(); onReady()
                            } else onPayload(payload)
                        }
                        else -> throw ProtocolFailure("电脑返回未知协议消息")
                    }
                }
            }
            if (overflow) throw ProtocolFailure("消息积压，连接已关闭")
        } finally {
            timeout.cancel(); sender.cancel(); outbound.close(); input.close(); ws.cancel()
            if (socket === ws) { socket = null; commands = null }
        }
    }
}
