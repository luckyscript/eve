package com.eve.android.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.eve.android.R
import com.eve.android.SecureCaptureActivity
import com.eve.android.data.*
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.serialization.json.*

private val Teal = Color(0xFF167D8D)
private val Ivory = Color(0xFFFAF7EF)
private val Dark = Color(0xFF121C1D)

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun EveApp(repository: EveRepository, deepLink: String?, consumed: () -> Unit) {
    val vm: EveViewModel = viewModel(factory = EveViewModel.factory(repository))
    val state by vm.state.collectAsStateWithLifecycle()
    var page by rememberSaveable { mutableStateOf("devices") }
    var pairOpen by remember { mutableStateOf(false) }
    var pairText by remember { mutableStateOf("") } // Credentials are never in SavedInstanceState.
    var pairError by remember { mutableStateOf<String?>(null) }
    var unpair by remember { mutableStateOf<String?>(null) }
    var darkMode by rememberSaveable { mutableIntStateOf(0) }
    val dark = when(darkMode) { 1 -> false; 2 -> true; else -> isSystemInDarkTheme() }
    val colors = if (dark) darkColorScheme(primary = Color(0xFF80D3D9), background = Dark, surface = Dark, secondaryContainer = Color(0xFF234B50))
        else lightColorScheme(primary = Teal, background = Ivory, surface = Ivory, secondaryContainer = Color(0xFFD6EBE8))
    val context = LocalContext.current
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let { pairText = it; pairOpen = true; pairError = null }
    }
    fun scan() { scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("扫描 Eve 电脑端配对二维码")
        .setBeepEnabled(false).setOrientationLocked(false).setCaptureActivity(SecureCaptureActivity::class.java)) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scan() else { pairError = "相机权限未开启，也可以粘贴配对链接"; pairOpen = true }
    }
    LaunchedEffect(deepLink) { deepLink?.let { pairText = it; pairOpen = true; pairError = null; consumed() } }
    MaterialTheme(colorScheme = colors) {
        Surface(Modifier.fillMaxSize()) {
            Scaffold(topBar = {
                TopAppBar(title = { Row(verticalAlignment = Alignment.CenterVertically) {
                    Image(painterResource(R.drawable.eve_logo), "Eve 标志", Modifier.size(36.dp).clip(CircleShape))
                    Spacer(Modifier.width(10.dp)); Column { Text("Eve · 夏娃"); Text(state.connection, style = MaterialTheme.typography.labelSmall) }
                } }, actions = {
                    IconButton(onClick = { darkMode = (darkMode + 1) % 3 }) { Icon(Icons.Default.Contrast, "主题：${listOf("跟随系统", "浅色", "深色")[darkMode]}，点按切换") }
                    IconButton(onClick = { if (state.online) repository.refresh() else repository.reconnect() }, enabled = state.loaded) { Icon(Icons.Default.Sync, "同步或重新连接") }
                })
            }, bottomBar = {
                NavigationBar {
                    listOf(Triple("devices", "电脑", Icons.Default.Computer), Triple("sessions", "会话", Icons.AutoMirrored.Filled.Chat), Triple("status", "能力", Icons.Default.AutoAwesome)).forEach { (id, label, icon) ->
                        NavigationBarItem(selected = page == id || (page == "chat" && id == "sessions"), onClick = { page = id }, icon = { Icon(icon, label) }, label = { Text(label) })
                    }
                }
            }) { inset ->
                Column(Modifier.padding(inset).fillMaxSize()) {
                    state.error?.let { error ->
                        Surface(color = MaterialTheme.colorScheme.errorContainer) {
                            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(error, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                                IconButton(onClick = repository::clearError) { Icon(Icons.Default.Close, "关闭提示") }
                            }
                        }
                    }
                    when(page) {
                        "devices" -> Devices(state, onPair = { pairText = ""; pairError = null; pairOpen = true }, select = repository::selectDevice, unpair = { unpair = it })
                        "sessions" -> Sessions(state, open = { repository.openSession(it); page = "chat" })
                        "chat" -> Chat(state, send = repository::send, cancel = repository::cancel, sync = repository::refresh)
                        "status" -> Status(state, repository::compact)
                    }
                }
            }
            if (pairOpen) AlertDialog(onDismissRequest = { pairText = ""; pairError = null; pairOpen = false },
                icon = { Image(painterResource(R.drawable.eve_avatar), "Eve 头像", Modifier.size(64.dp).clip(CircleShape)) },
                title = { Text("连接你的 Eve 电脑") },
                text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("在电脑 Eve 中生成邀请。配对信息只保存在此设备的加密存储中。")
                    OutlinedTextField(value = pairText, onValueChange = { pairText = it.take(8192); pairError = null }, label = { Text("配对链接") }, modifier = Modifier.testTag("pairInput"), visualTransformation = PasswordVisualTransformation(), maxLines = 3)
                    pairError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    OutlinedButton(onClick = {
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scan() else permission.launch(Manifest.permission.CAMERA)
                    }) { Icon(Icons.Default.QrCodeScanner, "扫描二维码"); Spacer(Modifier.width(8.dp)); Text("扫描二维码") }
                    Text("仅支持 Eve Remote v1；需电脑与 relay 在线。", style = MaterialTheme.typography.bodySmall)
                } },
                confirmButton = { TextButton(onClick = {
                    repository.importPair(pairText) { ok, error -> if (ok) { pairText = ""; pairOpen = false; page = "devices" } else pairError = error }
                }, enabled = pairText.isNotBlank() && state.loaded) { Text("配对") } },
                dismissButton = { TextButton(onClick = { pairText = ""; pairOpen = false }) { Text("取消") } })
            unpair?.let { id -> AlertDialog(onDismissRequest = { unpair = null }, title = { Text("解绑电脑？") }, text = { Text("将删除本机的配对密钥、待恢复记录和本地聊天缓存。电脑端的撤销操作需在电脑上完成。") },
                confirmButton = { TextButton(onClick = { repository.unpair(id); unpair = null }) { Text("删除本地密钥") } }, dismissButton = { TextButton(onClick = { unpair = null }) { Text("保留") } }) }
        }
    }
}

@Composable private fun Devices(state: AppState, onPair: () -> Unit, select: (String) -> Unit, unpair: (String) -> Unit) {
    LazyColumn(Modifier.fillMaxSize().testTag("devices"), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Text("你的电脑", style = MaterialTheme.typography.headlineMedium) }
        if (state.devices.isEmpty()) item { Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp)) {
            Image(painterResource(R.drawable.eve_avatar), "Eve 夏娃头像", Modifier.size(108.dp).clip(CircleShape))
            Spacer(Modifier.height(20.dp)); Text("让 Eve 随你同行", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(8.dp)); Text("通过 relay 安全连接你的电脑，继续会话、执行任务、查看技能与上下文。")
        } }
        items(state.devices, key = { it.invite.pairId }) { device ->
            val selected = device.invite.pairId == state.selectedPairId
            Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(device.invite.desktopName, style = MaterialTheme.typography.titleLarge)
                Text(if (selected) state.connection else "离线 · 未选择", color = if (selected && state.online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                Text(if (device.bound) "已配对 · 密钥由 Android Keystore 保护" else "待验证 · 尚未完成首次认证", style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { select(device.invite.pairId) }, enabled = !selected && !state.busy) { Text(if (selected) "当前电脑" else "选择电脑") }
                    TextButton(onClick = { unpair(device.invite.pairId) }, enabled = !state.busy || !selected) { Text("解绑") }
                }
            } }
        }
        item { Button(onClick = onPair, enabled = state.loaded && !state.busy, modifier = Modifier.fillMaxWidth().testTag("addDevice")) { Icon(Icons.Default.Add, null); Text("添加电脑") } }
        item { Text("应用进入后台会暂停连接；返回前台后同步。没有 FCM 或后台常连保证。任务在电脑运行，网络断开不会自动重发。", style = MaterialTheme.typography.bodySmall) }
        if (state.busy) item { Text("任务进行中，暂不能切换电脑。可前往聊天取消或同步原任务。") }
    }
}

@Composable private fun Sessions(state: AppState, open: (String?) -> Unit) {
    LazyColumn(Modifier.fillMaxSize().testTag("sessions"), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("会话", style = MaterialTheme.typography.headlineMedium)
            Button(onClick = { open(null) }, enabled = state.selectedPairId != null && !state.busy) { Text("新会话") }
        } }
        if (state.sessions.isEmpty()) item { Text(if (state.online) "还没有会话，开始一次新的对话。" else "电脑离线。重连后可同步会话，已打开的聊天保留在本机。") }
        items(state.sessions, key = { it.id }) { session ->
            ElevatedCard(onClick = { open(session.id) }, enabled = !state.busy || state.sessionId == session.id, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(session.title, style = MaterialTheme.typography.titleMedium)
                    Text(session.id, style = MaterialTheme.typography.labelSmall)
                    Text(session.status.ifBlank { "状态未提供" }, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        if (state.pending.isNotEmpty()) item { Text("待恢复任务", style = MaterialTheme.typography.titleMedium) }
        items(state.pending, key = { it.requestId }) { run -> Text("${run.state} · ${run.requestId}\n${run.prompt.take(180)}", style = MaterialTheme.typography.bodySmall) }
        if (state.pending.isNotEmpty() || state.timeline.isNotEmpty()) item { OutlinedButton(onClick = { open(state.sessionId) }) { Text("返回本地聊天") } }
    }
}

@Composable private fun Chat(state: AppState, send: (String) -> Unit, cancel: () -> Unit, sync: () -> Unit) {
    var prompt by rememberSaveable(state.selectedPairId, state.sessionId) { mutableStateOf("") }
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    var showEvents by remember(state.sessionId) { mutableStateOf(false) }
    LaunchedEffect(state.timeline.size, state.events.size) { val n = state.timeline.size + if (state.events.isNotEmpty()) 2 else 1; if(n > 0) listState.animateScrollToItem((n - 1).coerceAtLeast(0)) }
    Column(Modifier.fillMaxSize().testTag("chat")) {
        Text(state.sessionId?.let { "会话 $it" } ?: "新会话 · 首次回复后保存到电脑", Modifier.padding(horizontal = 20.dp, vertical = 8.dp), style = MaterialTheme.typography.labelSmall)
        LazyColumn(state = listState, modifier = Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (state.timeline.isEmpty()) item { Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Image(painterResource(R.drawable.eve_avatar), "Eve 头像", Modifier.size(72.dp).clip(CircleShape)); Spacer(Modifier.height(12.dp)); Text("今天想一起做什么？", style = MaterialTheme.typography.titleLarge)
            } }
            items(state.timeline, key = { it.id }) { message ->
                val assistant = message.role == "assistant"
                Row(Modifier.fillMaxWidth(), horizontalArrangement = if (assistant) Arrangement.Start else Arrangement.End) {
                    if (assistant) { Image(painterResource(R.drawable.eve_avatar), "Eve 助手", Modifier.size(28.dp).clip(CircleShape)); Spacer(Modifier.width(8.dp)) }
                    Surface(color = if (assistant) MaterialTheme.colorScheme.surfaceContainer else MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.large, modifier = Modifier.widthIn(max = 560.dp).weight(1f, fill = false)) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(if (assistant) "Eve" else "你", style = MaterialTheme.typography.labelMedium)
                            Text(message.text)
                            if (message.status.isNotBlank()) Text(message.status, style = MaterialTheme.typography.labelSmall)
                            if (message.model.isNotBlank()) Text("模型：${message.model}", style = MaterialTheme.typography.bodySmall)
                            if (message.verification.isNotBlank()) Text("验证：${message.verification}", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
            if (state.events.isNotEmpty()) item { Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
                TextButton(onClick = { showEvents = !showEvents }) { Text(if (showEvents) "收起任务进度 · ${state.events.size} 条" else "查看任务进度 · ${state.events.size} 条") }
                if (showEvents || state.busy) state.events.takeLast(if (showEvents) 20 else 3).forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
            } } }
            item { Spacer(Modifier.height(4.dp)) }
        }
        if (state.busy || state.pending.isNotEmpty()) Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (state.online) "任务执行 / 状态恢复中" else "等待重连 · 原任务 ID 已保存", Modifier.weight(1f), style = MaterialTheme.typography.labelSmall)
            TextButton(onClick = sync, enabled = state.online) { Text("只读同步") }
            TextButton(onClick = cancel, enabled = state.online && state.busy) { Text("取消任务") }
        }
        Row(Modifier.fillMaxWidth().imePadding().padding(12.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(value = prompt, onValueChange = { prompt = it.take(24000) }, label = { Text(if (state.online) "发消息给 Eve" else "电脑离线，可先起草") }, maxLines = 5, modifier = Modifier.weight(1f).testTag("messageInput"))
            FilledIconButton(onClick = { val text = prompt; prompt = ""; send(text) }, enabled = state.online && !state.busy && prompt.isNotBlank(), modifier = Modifier.testTag("sendMessage")) { Icon(Icons.Default.ArrowUpward, "发送消息") }
        }
    }
}

@Composable private fun Status(state: AppState, compact: () -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("能力与上下文", style = MaterialTheme.typography.headlineMedium)
        Projection("电脑与权限", state.desktopInfo)
        Projection("Skills", state.skills)
        Projection("Capabilities", state.capabilities)
        Projection("当前会话 Context", state.context)
        OutlinedButton(onClick = compact, enabled = state.online && state.sessionId != null && !state.busy) { Text("压缩当前会话上下文") }
        Text("权限由电脑本地控制；禁用的远程权限无法在手机开启。v1 不支持附件、推送、任意工作目录、远程密钥配置或进化管理。", style = MaterialTheme.typography.bodySmall)
    }
}
@Composable private fun Projection(title: String, data: JsonObject?) {
    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(data?.let { formatProjection(it) } ?: "尚未同步", style = MaterialTheme.typography.bodySmall)
    } }
}
private fun formatProjection(element: JsonElement, depth: Int = 0): String = when {
    depth > 5 -> "…"
    element is JsonObject -> element.entries.joinToString("\n") { (key, value) ->
        "$key: ${if (value is JsonPrimitive && value.booleanOrNull == false) "已禁用" else formatProjection(value, depth + 1)}"
    }
    element is JsonArray -> element.take(100).joinToString("\n\n") { formatProjection(it, depth + 1) }
    element is JsonPrimitive -> element.content.take(4000)
    else -> element.toString().take(4000)
}
