package com.eve.android.data

import com.eve.android.pairing.Invite
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable data class Device(val invite: Invite, val bound: Boolean = false)
@Serializable data class TimelineItem(val id: String, val role: String, val text: String, val status: String = "", val model: String = "", val verification: String = "")
@Serializable data class PendingRun(val requestId: String, val pairId: String, val prompt: String, val sessionId: String? = null, val state: String = "sending")
@Serializable data class SavedState(
    val clientId: String,
    val devices: List<Device> = emptyList(),
    val selectedPairId: String? = null,
    val timelines: Map<String, List<TimelineItem>> = emptyMap(),
    val pending: List<PendingRun> = emptyList()
)

data class SessionSummary(val id: String, val title: String, val status: String)
data class AppState(
    val loaded: Boolean = false,
    val devices: List<Device> = emptyList(),
    val selectedPairId: String? = null,
    val connection: String = "离线",
    val online: Boolean = false,
    val error: String? = null,
    val sessions: List<SessionSummary> = emptyList(),
    val sessionId: String? = null,
    val timeline: List<TimelineItem> = emptyList(),
    val busy: Boolean = false,
    val pending: List<PendingRun> = emptyList(),
    val desktopInfo: JsonObject? = null,
    val skills: JsonObject? = null,
    val capabilities: JsonObject? = null,
    val context: JsonObject? = null,
    val events: List<String> = emptyList()
)

/** A finished transport operation can contain a failed independently verified task. */
fun resolvedRunStatus(operationState: String, taskStatus: String?): String =
    taskStatus?.takeIf { it.isNotBlank() } ?: if (operationState == "completed") "failed" else operationState

/** Durable request ids survive even when run.start has not returned a session id. */
object PendingQueue {
    fun add(queue: List<PendingRun>, run: PendingRun): List<PendingRun> {
        val existing = queue.find { it.requestId == run.requestId }
        require(existing == null || existing == run) { "requestId 冲突" }
        require(queue.size < 64 || existing != null) { "待恢复任务过多，请先同步" }
        return if (existing != null) queue else queue + run
    }
    fun recover(queue: List<PendingRun>, pairId: String): List<String> = queue.filter { it.pairId == pairId }.map { it.requestId }.distinct()
}
