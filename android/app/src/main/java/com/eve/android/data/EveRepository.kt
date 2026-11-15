package com.eve.android.data

import android.content.Context
import com.eve.android.BuildConfig
import com.eve.android.pairing.Pairing
import com.eve.android.storage.SecureStore
import com.eve.android.transport.ProtocolFailure
import com.eve.android.transport.RelayTransport
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import kotlin.random.Random

class EveRepository(context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val store = SecureStore(context)
    private val diskMutex = Mutex()
    private val actionMutex = Mutex()
    private var saved = SavedState(UUID.randomUUID().toString())
    private var foreground = false
    private var connectionJob: Job? = null
    private var transport: RelayTransport? = null
    private data class Call(val op: String, val target: String? = null)
    private val calls = linkedMapOf<String, Call>()
    private val mutable = MutableStateFlow(AppState())
    val state = mutable.asStateFlow()
    init { scope.launch {
        try {
            saved = withContext(Dispatchers.IO) { store.load() }
            publish { copy(loaded = true) }
            if (foreground) connect()
        } catch (_: Exception) { publish { copy(error = "无法读取 Keystore 加密存储。请保留应用数据并检查设备锁屏/密钥状态。") } }
    } }
    private fun publish(change: AppState.() -> AppState = { this }) {
        mutable.update { old -> old.copy(devices = saved.devices, selectedPairId = saved.selectedPairId,
            pending = saved.pending.filter { it.pairId == saved.selectedPairId }).change() }
    }
    private suspend fun persist() = diskMutex.withLock { withContext(Dispatchers.IO) { store.save(saved) } }
    private fun action(block: suspend () -> Unit) { scope.launch {
        actionMutex.withLock {
            try { block() } catch (e: CancellationException) { throw e }
            catch (e: ProtocolFailure) { publish { copy(error = e.publicMessage) } }
            catch (_: Exception) { publish { copy(error = "操作未完成，请检查连接并同步原任务；不会自动重发。") } }
        }
    } }
    fun clearError() = publish { copy(error = null) }
    fun setForeground(active: Boolean) {
        foreground = active
        if (active && state.value.loaded) connect()
        if (!active) {
            connectionJob?.cancel(); connectionJob = null; transport?.close()
            publish { copy(online = false, connection = "已暂停 · 返回前台后同步") }
        }
    }
    fun importPair(uri: String, result: (Boolean, String?) -> Unit) = action {
        if (!state.value.loaded) { result(false, "加密存储尚未就绪"); return@action }
        if (state.value.busy) { result(false, "请先等待或取消当前任务"); return@action }
        val invite = try { Pairing.parse(uri, BuildConfig.DEBUG) } catch (e: Exception) { result(false, e.message ?: "配对数据无效"); return@action }
        if (saved.devices.any { it.invite.pairId == invite.pairId }) { result(false, "此电脑已配对，请直接重连"); return@action }
        if (saved.devices.size >= 16) { result(false, "最多保存 16 台电脑"); return@action }
        saved = saved.copy(devices = saved.devices + Device(invite), selectedPairId = invite.pairId)
        persist(); resetSelection(); publish(); result(true, null); restart()
    }
    fun selectDevice(id: String) = action {
        if (state.value.busy || id == saved.selectedPairId) return@action
        if (saved.devices.none { it.invite.pairId == id }) return@action
        saved = saved.copy(selectedPairId = id); persist(); resetSelection(); publish(); restart()
    }
    fun unpair(id: String) = action {
        if (state.value.busy && id == saved.selectedPairId) return@action
        val next = saved.devices.filterNot { it.invite.pairId == id }
        saved = saved.copy(devices = next, selectedPairId = if (saved.selectedPairId == id) next.firstOrNull()?.invite?.pairId else saved.selectedPairId,
            pending = saved.pending.filterNot { it.pairId == id }, timelines = saved.timelines.filterKeys { !it.startsWith("$id:") })
        persist(); resetSelection(); publish(); restart()
    }
    private fun resetSelection() = publish { copy(sessions = emptyList(), sessionId = null, timeline = emptyList(), events = emptyList(), busy = false, desktopInfo = null, skills = null, capabilities = null, context = null) }
    private fun restart() { connectionJob?.cancel(); connectionJob = null; transport?.close(); if (foreground) connect() }
    fun reconnect() { restart() }
    private fun connect() {
        if (connectionJob?.isActive == true || !foreground) return
        val device = saved.devices.find { it.invite.pairId == saved.selectedPairId } ?: return
        connectionJob = scope.launch {
            var attempts = 0
            while (isActive && foreground && attempts < 8) {
                publish { copy(connection = if (attempts == 0) "连接中 · 验证电脑身份" else "重连中 · 第 $attempts 次", online = false) }
                val link = RelayTransport(BuildConfig.DEBUG); transport = link
                try {
                    link.connect(device.invite, saved.clientId, onReady = {
                        attempts = 0
                        // Invite expiry applies only to import, never to a persisted credential reconnect.
                        saved = saved.copy(devices = saved.devices.map { if (it.invite.pairId == device.invite.pairId) it.copy(bound = true) else it })
                        persist(); calls.clear()
                        publish { copy(online = true, connection = "在线 · 已验证加密连接", error = null) }
                        refreshNow()
                        for (id in PendingQueue.recover(saved.pending, device.invite.pairId)) request("run.lookup", obj("requestId" to id), id)
                    }, onPayload = { payload -> handle(payload) })
                } catch (e: CancellationException) { throw e }
                catch (e: ProtocolFailure) {
                    publish { copy(online = false, connection = "验证失败", error = e.publicMessage) }; return@launch
                } catch (_: Exception) { /* No URL or exception is logged: it may carry a credential. */ }
                finally { link.close(); publish { copy(online = false) } }
                attempts++
                publish { copy(connection = "离线 · 等待重连；任务不会重发") }
                delay((1000L shl (attempts - 1).coerceAtMost(5)) + Random.nextLong(250, 1000))
            }
            publish { copy(online = false, connection = "离线 · 自动重连已暂停，请手动重连") }
        }
    }
    private fun key(sessionId: String?) = "${saved.selectedPairId}:${sessionId ?: "draft"}"
    private suspend fun request(op: String, params: JsonObject = buildJsonObject {}, target: String? = null, id: String = UUID.randomUUID().toString()) {
        if (!state.value.online) throw ProtocolFailure("电脑离线，请重连后同步")
        if (calls.size >= 128) throw ProtocolFailure("等待响应过多，请重连")
        calls[id] = Call(op, target)
        try { transport!!.send(buildJsonObject { put("kind", "request"); put("id", id); put("op", op); put("params", params) }) }
        catch (e: Exception) { calls.remove(id); throw e }
    }
    fun refresh() = action { refreshNow(); saved.pending.filter { it.pairId == saved.selectedPairId }.forEach { request("run.lookup", obj("requestId" to it.requestId), it.requestId) } }
    private suspend fun refreshNow() {
        request("desktop.info"); request("sessions.list"); request("skills.list"); request("capabilities.list")
        state.value.sessionId?.let { request("sessions.get", obj("sessionId" to it), it); request("context.status", obj("sessionId" to it), it) }
    }
    fun openSession(id: String?) = action {
        if (state.value.busy && id != state.value.sessionId) return@action
        publish { copy(sessionId = id, timeline = saved.timelines[key(id)].orEmpty(), events = emptyList(), context = null) }
        if (id != null && state.value.online) { request("sessions.get", obj("sessionId" to id), id); request("context.status", obj("sessionId" to id), id) }
    }
    fun send(prompt: String) = action {
        val text = prompt.trim()
        if (text.isEmpty() || state.value.busy || !state.value.online) return@action
        if (text.toByteArray().size > 48 * 1024) throw ProtocolFailure("消息过长，请缩短后发送")
        val pair = saved.selectedPairId ?: return@action
        val sid = state.value.sessionId
        val id = UUID.randomUUID().toString()
        val run = PendingRun(id, pair, text, sid)
        val timeline = (saved.timelines[key(sid)].orEmpty() + TimelineItem(id, "user", text, "等待电脑确认")).takeLast(400)
        saved = saved.copy(pending = PendingQueue.add(saved.pending, run), timelines = saved.timelines + (key(sid) to timeline))
        // Save before touching transport. Even absence of sessionId must never lose requestId.
        persist(); publish { copy(timeline = timeline, busy = true, events = emptyList()) }
        request("run.start", buildJsonObject { put("prompt", text); sid?.let { put("sessionId", it) } }, id, id)
    }
    fun cancel() = action {
        val run = saved.pending.lastOrNull { it.pairId == saved.selectedPairId } ?: return@action
        request("run.cancel", obj("requestId" to run.requestId), run.requestId)
    }
    fun compact() = action {
        val sid = state.value.sessionId ?: return@action
        if (!state.value.busy) request("context.compact", obj("sessionId" to sid), sid)
    }
    private suspend fun handle(payload: JsonObject) {
        when (payload.str("kind")) {
            "event" -> {
                val rid = payload.str("requestId")
                if (saved.pending.none { it.requestId == rid && it.pairId == saved.selectedPairId }) return
                val event = payload["event"] as? JsonObject ?: return
                val summary = listOf("type", "kind", "name", "tool", "status", "step", "message", "skillHash").mapNotNull { field -> event[field]?.let { "$field: ${it.toString().take(300)}" } }.joinToString(" · ")
                publish { copy(events = (events + summary.ifBlank { "收到任务进度" }).takeLast(100), busy = true) }
            }
            "response" -> {
                val id = payload.str("id")
                val call = calls.remove(id) ?: return
                if (payload["ok"]?.jsonPrimitive?.booleanOrNull != true) {
                    val code = (payload["error"] as? JsonObject)?.str("code").orEmpty().take(80)
                    // Keep server-provided text out of credential-sensitive errors; code is sufficient to diagnose.
                    publish { copy(error = "电脑拒绝 ${call.op}（$code）") }
                    if (call.op == "run.start") finishRun(id, null, "failed", "电脑拒绝任务（$code）")
                    return
                }
                val result = payload["result"] as? JsonObject ?: buildJsonObject {}
                when (call.op) {
                    "desktop.info" -> publish { copy(desktopInfo = result) }
                    "sessions.list" -> publish { copy(sessions = (result["sessions"] as? JsonArray).orEmpty().mapNotNull {
                        val s = it as? JsonObject ?: return@mapNotNull null
                        SessionSummary(s.str("id"), s.str("title").ifBlank { "未命名会话" }, s.str("status"))
                    }.take(500)) }
                    "sessions.get" -> syncSession(call.target, result)
                    "skills.list" -> publish { copy(skills = result) }
                    "capabilities.list" -> publish { copy(capabilities = result) }
                    "context.status", "context.compact" -> if (call.target == state.value.sessionId) publish { copy(context = result) }
                    "run.start" -> finishRun(id, result, result.str("status").ifBlank { "completed" })
                    "run.lookup" -> {
                        val rid = call.target ?: return
                        when (result.str("state")) {
                            "completed", "failed" -> {
                                val runResult = result["result"] as? JsonObject
                                val taskStatus = resolvedRunStatus(result.str("state"), runResult?.str("status"))
                                finishRun(rid, runResult, taskStatus, if (taskStatus != "completed") "电脑任务失败或已中断" else null)
                            }
                            "running" -> { saved = saved.copy(pending = saved.pending.map { if (it.requestId == rid) it.copy(state = "running") else it }); persist(); publish { copy(busy = true) } }
                            else -> {
                                saved = saved.copy(pending = saved.pending.map { if (it.requestId == rid) it.copy(state = "unknown") else it }); persist()
                                publish { copy(busy = false, error = "原任务 $rid 状态未知或已中断。已保留记录，不会自动重发；可只读同步电脑会话。") }
                            }
                        }
                    }
                    "run.cancel" -> publish { copy(events = (events + if (result["requested"]?.jsonPrimitive?.booleanOrNull == true) "已向电脑请求取消，等待最终状态" else "电脑未确认取消，请同步原任务").takeLast(100)) }
                }
            }
        }
    }
    private suspend fun syncSession(id: String?, result: JsonObject) {
        if (id == null) return
        val runs = (result["runs"] as? JsonArray).orEmpty()
        val remote = runs.flatMap { element ->
            val r = element as? JsonObject ?: return@flatMap emptyList()
            listOf(TimelineItem("${r.str("id")}:prompt", "user", r.str("prompt")),
                TimelineItem("${r.str("id")}:final", "assistant", r.str("final").ifBlank { "（尚无最终回复）" }, r.str("status"), r.str("modelStatus"), (r["verification"] as? JsonObject)?.str("status").orEmpty()))
        }
        val unresolved = saved.pending.filter { it.pairId == saved.selectedPairId && it.sessionId == id }.map { TimelineItem(it.requestId, "user", it.prompt, "待恢复 · ${it.state}") }
        val items = (remote + unresolved.filter { pending -> remote.none { it.role == "user" && it.text == pending.text } }).takeLast(400)
        saved = saved.copy(timelines = saved.timelines + (key(id) to items)); persist()
        if (state.value.sessionId == id) publish { copy(timeline = items, events = if (result["truncated"]?.jsonPrimitive?.booleanOrNull == true) listOf("电脑历史已截断，显示可用部分") else events) }
    }
    private suspend fun finishRun(rid: String, result: JsonObject?, status: String, fallback: String? = null) {
        val pending = saved.pending.find { it.requestId == rid && it.pairId == saved.selectedPairId } ?: return
        val sid = result?.str("sessionId")?.takeIf { it.isNotBlank() } ?: pending.sessionId
        val oldKey = key(pending.sessionId)
        val targetKey = key(sid)
        val items = (saved.timelines[oldKey].orEmpty().map { if (it.id == rid) it.copy(status = status) else it } +
            TimelineItem("$rid:final", "assistant", result?.str("final")?.takeIf { it.isNotBlank() } ?: fallback ?: "（电脑未提供最终文本）", status,
                result?.str("modelStatus").orEmpty(), (result?.get("verification") as? JsonObject)?.str("status").orEmpty())).takeLast(400)
        saved = saved.copy(pending = saved.pending.filterNot { it.requestId == rid }, timelines = (saved.timelines - oldKey) + (targetKey to items))
        persist(); publish { copy(sessionId = sid, timeline = items, busy = false) }
        request("sessions.list")
        sid?.let { request("context.status", obj("sessionId" to it), it) }
    }
    private fun obj(vararg fields: Pair<String, String>) = buildJsonObject { fields.forEach { put(it.first, it.second) } }
}
fun JsonObject.str(key: String): String = (get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()
