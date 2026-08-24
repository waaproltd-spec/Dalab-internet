package com.dalab.internet.ui

import android.content.Context
import android.graphics.BitmapFactory
import android.media.MediaPlayer
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Done
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicNone
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaRecorder
import com.dalab.internet.data.SupportConversation
import com.dalab.internet.data.SupportConversationStatus
import com.dalab.internet.data.SupportMessage
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.SupportSendMessageRequest
import com.dalab.internet.network.SupportStatusUpdateRequest
import com.dalab.internet.support.SupportQueueState
import com.dalab.internet.util.formatApiDateTime
import com.dalab.internet.util.parseApiDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

// Shared with the Customer App's Agent Support chat -- same brand indigo
// (see OrdersListScreen.kt's DalabIndigo), used as the fixed fill for the
// agent's own outgoing bubbles so they read the same dark-navy regardless
// of light/dark theme, same as the customer side.
private val ChatIndigo = Color(0xFF003152)

/**
 * The Agent App's counterpart to the Admin Dashboard's "Agent Support" panel
 * (super-admin-app/src/App.jsx) — same backend routes (dual-registered at
 * /admin/support/... and /agent/support/... by support.routes.ts), same
 * queue, same conversations. Online/offline toggle, the live waiting list
 * with a claim-next shortcut, and — once a conversation is assigned to this
 * agent — a WhatsApp/Telegram-style chat (text, images, voice messages)
 * with Resolve/Close. Real time comes from the same SSE stream
 * (agent/orders/stream, via AgentEventBus.orderEvents) every other screen
 * in this app already reuses; the backend broadcasts
 * support_conversation.updated on it exactly like it does order.updated, so
 * this screen just re-fetches on any event rather than trusting a payload.
 *
 * Message content (text, images, voice) is ephemeral by design: the backend
 * hard-deletes every message row for a conversation the instant it ends
 * (resolve/close) -- see support.routes.ts's endConversationAndAutoClaim.
 * This screen doesn't need to do anything special for that; once ended,
 * refresh() simply stops returning an assigned conversation, same as always.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SupportScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    var online by remember { mutableStateOf(false) }
    var activeConversationId by remember { mutableStateOf<String?>(null) }
    var queue by remember { mutableStateOf<List<SupportConversation>>(emptyList()) }
    var conversation by remember { mutableStateOf<SupportConversation?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var claimingId by remember { mutableStateOf<String?>(null) }
    var togglingOnline by remember { mutableStateOf(false) }
    var messageText by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var sendingMedia by remember { mutableStateOf(false) }
    var ending by remember { mutableStateOf(false) }
    var recording by remember { mutableStateOf(false) }
    var recordingSeconds by remember { mutableIntStateOf(0) }
    var playingMessageId by remember { mutableStateOf<String?>(null) }
    var loadingAudioId by remember { mutableStateOf<String?>(null) }
    var voicePositionMs by remember { mutableIntStateOf(0) }
    // Keyed by message id so a duration learned once (on first play) survives
    // recomposition -- MediaPlayer only reports it once prepare() finishes,
    // there's no server-side duration field to read up front.
    val voiceDurationsMs = remember { mutableStateMapOf<String, Int>() }
    val scope = rememberCoroutineScope()

    val recorderHolder = remember { MediaRecorderHolder(context) }
    val player = remember { MediaPlayer() }
    DisposableEffect(Unit) {
        onDispose {
            recorderHolder.cancel()
            player.release()
        }
    }

    suspend fun refresh() {
        try {
            val status = ApiClient.service.getSupportStatus().body()
            online = status?.online ?: false
            activeConversationId = status?.activeConversationId

            val currentId = activeConversationId
            if (currentId != null) {
                conversation = ApiClient.service.getSupportConversation(currentId).body()
            } else {
                conversation = null
                val fetchedQueue = ApiClient.service.getSupportQueue().body().orEmpty()
                queue = fetchedQueue
                SupportQueueState.update(fetchedQueue)
            }
            error = null
        } catch (e: Exception) {
            error = "Couldn't refresh: ${e.message ?: "network error"}"
        }
        loading = false
    }

    LaunchedEffect(Unit) { refresh() }
    // Backend broadcasts support_conversation.updated on this exact same
    // stream AgentBackgroundService keeps connected for order events -- no
    // separate connection needed, just re-fetch on any signal.
    LaunchedEffect(Unit) { AgentEventBus.orderEvents.collect { refresh() } }

    fun toggleOnline(next: Boolean) {
        togglingOnline = true
        scope.launch {
            try {
                ApiClient.service.setSupportStatus(SupportStatusUpdateRequest(next))
                // Going offline mid-conversation reassigns it back to the pool
                // server-side (support.routes.ts's PUT /support/status) --
                // this refresh is what picks that up and clears the chat view.
                refresh()
            } catch (e: Exception) {
                error = "Couldn't update status: ${e.message ?: "network error"}"
            }
            togglingOnline = false
        }
    }

    fun claimNext() {
        claimingId = "__next__"
        scope.launch {
            try {
                val result = ApiClient.service.claimNextSupportConversation().body()
                if (result?.claimed == null) {
                    error = "No customers waiting right now."
                }
                refresh()
            } catch (e: Exception) {
                error = "Couldn't claim: ${e.message ?: "network error"}"
            }
            claimingId = null
        }
    }

    fun claimSpecific(id: String) {
        claimingId = id
        scope.launch {
            try {
                ApiClient.service.claimSupportConversation(id)
                refresh()
            } catch (e: Exception) {
                error = "Couldn't claim: ${e.message ?: "network error"}"
            }
            claimingId = null
        }
    }

    fun sendMessage() {
        val id = activeConversationId ?: return
        val text = messageText.trim()
        if (text.isEmpty()) return
        sending = true
        scope.launch {
            try {
                val updated = ApiClient.service.sendSupportMessage(id, SupportSendMessageRequest(message = text)).body()
                if (updated != null) conversation = updated
                messageText = ""
            } catch (e: Exception) {
                error = "Couldn't send: ${e.message ?: "network error"}"
            }
            sending = false
        }
    }

    fun sendMedia(type: String, bytes: ByteArray, mime: String) {
        val id = activeConversationId ?: return
        sendingMedia = true
        scope.launch {
            try {
                val dataUri = "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
                val updated = ApiClient.service.sendSupportMessage(
                    id,
                    SupportSendMessageRequest(messageType = type, mediaBase64 = dataUri),
                ).body()
                if (updated != null) conversation = updated
            } catch (e: Exception) {
                error = "Couldn't send: ${e.message ?: "network error"}"
            }
            sendingMedia = false
        }
    }

    val imagePickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            try {
                val bytes = withContext(Dispatchers.IO) {
                    context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                }
                if (bytes != null) {
                    val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
                    sendMedia("image", bytes, mime)
                }
            } catch (e: Exception) {
                error = "Couldn't attach image: ${e.message ?: "unknown error"}"
            }
        }
    }

    val recordPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            recording = true
            recordingSeconds = 0
            recorderHolder.start()
        }
    }

    fun hasRecordPermission() =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    fun toggleRecording() {
        if (recording) {
            recording = false
            val file = recorderHolder.stop()
            if (file != null && file.length() > 0) {
                scope.launch {
                    val bytes = withContext(Dispatchers.IO) { file.readBytes() }
                    sendMedia("voice", bytes, "audio/m4a")
                    file.delete()
                }
            }
        } else if (hasRecordPermission()) {
            recording = true
            recordingSeconds = 0
            recorderHolder.start()
        } else {
            recordPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    LaunchedEffect(recording) {
        while (recording) {
            kotlinx.coroutines.delay(1000)
            recordingSeconds += 1
        }
    }

    fun cancelRecording() {
        recording = false
        recorderHolder.cancel()
    }

    fun playVoice(message: SupportMessage) {
        if (message.mediaUrl == null) return
        if (playingMessageId == message.id) {
            player.stop()
            player.reset()
            playingMessageId = null
            voicePositionMs = 0
            return
        }
        loadingAudioId = message.id
        scope.launch {
            try {
                // GET .../support/messages/{id}/media takes the message's own
                // id as the path param -- message.mediaUrl only signals
                // "this is a media message" (see ImageBubbleContent, same
                // pattern), it isn't parsed for a path segment.
                val responseBody = ApiClient.service.getSupportMessageMedia(message.id).body()
                if (responseBody == null) {
                    error = "Couldn't load voice message"
                    loadingAudioId = null
                    return@launch
                }
                val tempFile = withContext(Dispatchers.IO) {
                    val file = File.createTempFile("support_voice_${message.id}", ".m4a", context.cacheDir)
                    file.outputStream().use { out -> responseBody.byteStream().copyTo(out) }
                    file
                }
                player.reset()
                player.setDataSource(tempFile.absolutePath)
                player.setOnCompletionListener {
                    playingMessageId = null
                    voicePositionMs = 0
                }
                player.prepare()
                voiceDurationsMs[message.id] = player.duration
                voicePositionMs = 0
                player.start()
                playingMessageId = message.id
            } catch (e: Exception) {
                error = "Couldn't play voice message: ${e.message ?: "unknown error"}"
            }
            loadingAudioId = null
        }
    }

    // Polls MediaPlayer's own position while something is playing --
    // MediaPlayer has no position-changed callback, unlike audioplayers on
    // the Customer App side, so this is the Android-native equivalent of
    // that stream.
    LaunchedEffect(playingMessageId) {
        while (playingMessageId != null) {
            kotlinx.coroutines.delay(200)
            try {
                if (player.isPlaying) voicePositionMs = player.currentPosition
            } catch (e: IllegalStateException) {
                // Player was reset/released concurrently -- next tick (or
                // the loop's own exit once playingMessageId clears) recovers.
            }
        }
    }

    fun endConversation(resolve: Boolean) {
        val id = activeConversationId ?: return
        ending = true
        scope.launch {
            try {
                if (resolve) ApiClient.service.resolveSupportConversation(id) else ApiClient.service.closeSupportConversation(id)
                // The backend auto-claims the next waiting customer for this
                // same agent right after ending this one (FIFO) -- refresh()
                // picks that up the same way it does everything else.
                refresh()
            } catch (e: Exception) {
                error = "Couldn't end conversation: ${e.message ?: "network error"}"
            }
            ending = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Agent Support")
                        if (conversation != null) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    conversation!!.customerName ?: conversation!!.customerPhone ?: "Customer",
                                    style = MaterialTheme.typography.labelSmall,
                                )
                                Spacer(Modifier.width(6.dp))
                                Box(
                                    modifier = Modifier.size(7.dp).background(Color(0xFF16A34A), CircleShape)
                                )
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    "Online",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = Color(0xFF16A34A),
                                    fontWeight = FontWeight.Bold,
                                )
                            }
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(end = 12.dp)) {
                        Text(if (online) "Online" else "Offline", style = MaterialTheme.typography.labelMedium)
                        Spacer(Modifier.width(8.dp))
                        Switch(checked = online, onCheckedChange = { toggleOnline(it) }, enabled = !togglingOnline)
                    }
                },
            )
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            when {
                loading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                conversation != null -> SupportConversationView(
                    conversation = conversation!!,
                    messageText = messageText,
                    onMessageChange = { messageText = it },
                    onSend = { sendMessage() },
                    sending = sending,
                    sendingMedia = sendingMedia,
                    recording = recording,
                    recordingSeconds = recordingSeconds,
                    playingMessageId = playingMessageId,
                    loadingAudioId = loadingAudioId,
                    voicePositionMs = voicePositionMs,
                    voiceDurationsMs = voiceDurationsMs,
                    onPickImage = {
                        imagePickerLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    },
                    onToggleRecording = { toggleRecording() },
                    onCancelRecording = { cancelRecording() },
                    onPlayVoice = { playVoice(it) },
                    onResolve = { endConversation(true) },
                    onClose = { endConversation(false) },
                    ending = ending,
                    error = error,
                )
                else -> SupportQueueView(
                    online = online,
                    queue = queue,
                    claimingId = claimingId,
                    error = error,
                    onClaimNext = { claimNext() },
                    onClaimSpecific = { claimSpecific(it) },
                )
            }
        }
    }
}

/** Wraps [android.media.MediaRecorder] with the same start/stop/cancel shape SupportScreen needs. */
private class MediaRecorderHolder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null

    fun start() {
        cancel()
        val file = File.createTempFile("support_voice_", ".m4a", context.cacheDir)
        outputFile = file
        @Suppress("DEPRECATION")
        val newRecorder = MediaRecorder()
        newRecorder.setAudioSource(MediaRecorder.AudioSource.MIC)
        newRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        newRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        newRecorder.setOutputFile(file.absolutePath)
        try {
            newRecorder.prepare()
            newRecorder.start()
            recorder = newRecorder
        } catch (e: Exception) {
            newRecorder.release()
            recorder = null
        }
    }

    /** Stops and returns the recorded file, or null if nothing was recording. */
    fun stop(): File? {
        val current = recorder ?: return null
        return try {
            current.stop()
            outputFile
        } catch (e: Exception) {
            null
        } finally {
            current.release()
            recorder = null
        }
    }

    fun cancel() {
        try {
            recorder?.stop()
        } catch (e: Exception) {
            // Never actually started recording anything -- nothing to stop.
        }
        recorder?.release()
        recorder = null
        outputFile?.delete()
        outputFile = null
    }
}

@Composable
private fun SupportQueueView(
    online: Boolean,
    queue: List<SupportConversation>,
    claimingId: String?,
    error: String?,
    onClaimNext: () -> Unit,
    onClaimSpecific: (String) -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Surface(color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(20.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        "${queue.size}",
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        if (queue.size == 1) "customer waiting" else "customers waiting",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                Button(onClick = onClaimNext, enabled = online && queue.isNotEmpty() && claimingId == null) {
                    Text(if (claimingId == "__next__") "Claiming…" else "Claim Next")
                }
            }
        }

        if (!online) {
            Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                Text(
                    "Go online to claim a waiting customer.",
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }
        error?.let {
            Text(
                it,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                style = MaterialTheme.typography.labelMedium,
            )
        }

        if (queue.isEmpty()) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                Text(
                    "No customers waiting right now.",
                    modifier = Modifier.align(Alignment.Center),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        } else {
            LazyColumn(modifier = Modifier.weight(1f).fillMaxWidth()) {
                items(queue, key = { it.id }) { item ->
                    QueueConversationCard(
                        item = item,
                        claiming = claimingId == item.id,
                        enabled = online && claimingId == null,
                        onClaim = { onClaimSpecific(item.id) },
                    )
                    Divider()
                }
            }
        }
    }
}

@Composable
private fun QueueConversationCard(
    item: SupportConversation,
    claiming: Boolean,
    enabled: Boolean,
    onClaim: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.weight(1f)) {
                Text(item.customerName ?: item.customerPhone ?: "Customer", fontWeight = FontWeight.Bold)
                Text(item.customerPhone ?: "", style = MaterialTheme.typography.bodySmall)
            }
            AssistChip(
                onClick = {},
                label = { Text(if (item.status == SupportConversationStatus.QUEUED) "Waiting" else "Left a message") },
            )
        }
        item.firstMessage?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(formatApiDateTime(item.createdAt), style = MaterialTheme.typography.labelSmall)
            OutlinedButton(onClick = onClaim, enabled = enabled) {
                Text(if (claiming) "Claiming…" else "Claim")
            }
        }
    }
}

@Composable
private fun SupportConversationView(
    conversation: SupportConversation,
    messageText: String,
    onMessageChange: (String) -> Unit,
    onSend: () -> Unit,
    sending: Boolean,
    sendingMedia: Boolean,
    recording: Boolean,
    recordingSeconds: Int,
    playingMessageId: String?,
    loadingAudioId: String?,
    voicePositionMs: Int,
    voiceDurationsMs: Map<String, Int>,
    onPickImage: () -> Unit,
    onToggleRecording: () -> Unit,
    onCancelRecording: () -> Unit,
    onPlayVoice: (SupportMessage) -> Unit,
    onResolve: () -> Unit,
    onClose: () -> Unit,
    ending: Boolean,
    error: String?,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        error?.let {
            Text(
                it,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                style = MaterialTheme.typography.labelMedium,
            )
        }

        Box(modifier = Modifier.weight(1f).fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f))) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
                reverseLayout = true,
            ) {
                val messages = conversation.messages
                itemsIndexed(messages.asReversed()) { reversedIndex, message ->
                    val realIndex = messages.size - 1 - reversedIndex
                    val previous = if (realIndex > 0) messages[realIndex - 1] else null
                    val next = if (realIndex < messages.size - 1) messages[realIndex + 1] else null
                    // reverseLayout only reverses which slot sits at the
                    // bottom overall -- content *within* one item's own
                    // lambda still stacks top-to-bottom normally, so the
                    // separator must be emitted before the bubble to land
                    // above (not below) the first message of that day.
                    if (shouldShowDateSeparator(previous, message)) {
                        DateSeparator(message.createdAt)
                    }
                    val isFirstInGroup = shouldShowDateSeparator(previous, message) || !isSameGroup(previous, message)
                    val isLastInGroup = shouldShowDateSeparator(message, next) || !isSameGroup(message, next)
                    val isPlaying = playingMessageId == message.id
                    MessageBubble(
                        message = message,
                        isFirstInGroup = isFirstInGroup,
                        isLastInGroup = isLastInGroup,
                        isPlaying = isPlaying,
                        isLoadingAudio = loadingAudioId == message.id,
                        voicePositionMs = if (isPlaying) voicePositionMs else 0,
                        voiceDurationMs = voiceDurationsMs[message.id],
                        onPlayVoice = { onPlayVoice(message) },
                    )
                }
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedButton(onClick = onResolve, enabled = !ending, modifier = Modifier.weight(1f)) {
                Icon(Icons.Filled.CheckCircle, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Resolve")
            }
            OutlinedButton(onClick = onClose, enabled = !ending, modifier = Modifier.weight(1f)) {
                Icon(Icons.Filled.Close, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Close")
            }
        }

        if (recording) {
            RecordingBar(
                seconds = recordingSeconds,
                onCancel = onCancelRecording,
                onSend = onToggleRecording,
            )
        } else {
            Row(
                modifier = Modifier.fillMaxWidth().padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                ComposerIconButton(icon = Icons.Filled.Image, enabled = !sendingMedia, onClick = onPickImage)
                OutlinedTextField(
                    value = messageText,
                    onValueChange = onMessageChange,
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Type a reply…") },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    maxLines = 4,
                    shape = RoundedCornerShape(24.dp),
                )
                if (messageText.isNotBlank()) {
                    SendButton(sending = sending, onClick = onSend)
                } else {
                    ComposerIconButton(icon = Icons.Filled.MicNone, enabled = !sendingMedia, onClick = onToggleRecording)
                }
            }
        }
    }
}

@Composable
private fun ComposerIconButton(icon: androidx.compose.ui.graphics.vector.ImageVector, enabled: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.padding(10.dp).size(22.dp))
    }
}

@Composable
private fun SendButton(sending: Boolean, onClick: () -> Unit) {
    Surface(onClick = onClick, enabled = !sending, shape = CircleShape, color = ChatIndigo) {
        Box(modifier = Modifier.padding(10.dp), contentAlignment = Alignment.Center) {
            if (sending) {
                CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp, color = Color.White)
            } else {
                Icon(Icons.Filled.Send, contentDescription = "Send", tint = Color.White, modifier = Modifier.size(22.dp))
            }
        }
    }
}

@Composable
private fun RecordingBar(seconds: Int, onCancel: () -> Unit, onSend: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ComposerIconButton(icon = Icons.Filled.Delete, enabled = true, onClick = onCancel)
        Row(
            modifier = Modifier.weight(1f)
                .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(24.dp))
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(modifier = Modifier.size(9.dp).background(Color(0xFFC81E2C), CircleShape))
            Spacer(Modifier.width(8.dp))
            Text("Recording…", fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            Text("%d:%02d".format(seconds / 60, seconds % 60))
        }
        SendButton(sending = false, onClick = onSend)
    }
}

private fun shouldShowDateSeparator(previous: SupportMessage?, current: SupportMessage?): Boolean {
    if (current == null) return false
    val currentDate = parseApiDate(current.createdAt) ?: return previous == null
    val previousDate = previous?.createdAt?.let { parseApiDate(it) } ?: return true
    val cal1 = Calendar.getInstance().apply { time = currentDate }
    val cal2 = Calendar.getInstance().apply { time = previousDate }
    return cal1.get(Calendar.YEAR) != cal2.get(Calendar.YEAR) ||
        cal1.get(Calendar.DAY_OF_YEAR) != cal2.get(Calendar.DAY_OF_YEAR)
}

/**
 * Whether [a] and [b] should render as one visually "stacked" group -- same
 * sender, back to back, within a few minutes of each other. Purely a display
 * grouping (collapses repeated avatars, tightens spacing, like WhatsApp/
 * Telegram) -- never changes what's sent/stored.
 */
private fun isSameGroup(a: SupportMessage?, b: SupportMessage?): Boolean {
    if (a == null || b == null) return false
    if (a.senderType == "system" || b.senderType == "system") return false
    if (a.senderType != b.senderType) return false
    val at = parseApiDate(a.createdAt) ?: return false
    val bt = parseApiDate(b.createdAt) ?: return false
    return kotlin.math.abs(bt.time - at.time) <= 3 * 60 * 1000L
}

@Composable
private fun DateSeparator(createdAt: String?) {
    val label = remember(createdAt) {
        val date = parseApiDate(createdAt)
        if (date == null) {
            "Today"
        } else {
            val today = Calendar.getInstance()
            val target = Calendar.getInstance().apply { time = date }
            if (today.get(Calendar.YEAR) == target.get(Calendar.YEAR) && today.get(Calendar.DAY_OF_YEAR) == target.get(Calendar.DAY_OF_YEAR)) {
                "Today"
            } else {
                SimpleDateFormat("MMM d", Locale.US).format(date)
            }
        }
    }
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.Center) {
        Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(50)) {
            Text(
                label,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun MessageBubble(
    message: SupportMessage,
    isFirstInGroup: Boolean,
    isLastInGroup: Boolean,
    isPlaying: Boolean,
    isLoadingAudio: Boolean,
    voicePositionMs: Int,
    voiceDurationMs: Int?,
    onPlayVoice: () -> Unit,
) {
    if (message.senderType == "system") {
        Row(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.Center) {
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(50)) {
                Text(
                    message.body ?: "",
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
        return
    }

    val isMe = message.senderType == "agent"
    val timeLabel = remember(message.createdAt) {
        parseApiDate(message.createdAt)?.let { SimpleDateFormat("HH:mm", Locale.US).format(it) } ?: ""
    }
    val bubbleColor = if (isMe) ChatIndigo else MaterialTheme.colorScheme.surface
    val textColor = if (isMe) Color.White else MaterialTheme.colorScheme.onSurface
    val timeColor = if (isMe) Color.White.copy(alpha = 0.7f) else MaterialTheme.colorScheme.onSurfaceVariant
    // The "connecting" side (right for me, left for the customer) loses its
    // rounding between grouped messages so consecutive bubbles read as one
    // stacked block, like WhatsApp/Telegram -- the far side always stays
    // fully rounded so the group still reads as chat bubbles, not a card.
    val topConnecting = if (isFirstInGroup) 14.dp else 4.dp
    val bottomConnecting = 4.dp

    Row(
        modifier = Modifier.fillMaxWidth().padding(top = if (isFirstInGroup) 10.dp else 2.dp, bottom = 2.dp),
        horizontalArrangement = if (isMe) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        if (!isMe) {
            if (isLastInGroup) {
                Box(
                    modifier = Modifier.size(28.dp).background(MaterialTheme.colorScheme.surfaceVariant, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.SupportAgent, contentDescription = null, modifier = Modifier.size(16.dp), tint = ChatIndigo)
                }
            } else {
                Spacer(Modifier.size(28.dp))
            }
            Spacer(Modifier.width(6.dp))
        }
        Surface(
            color = bubbleColor,
            shape = RoundedCornerShape(
                topStart = if (isMe) 14.dp else topConnecting,
                topEnd = if (isMe) topConnecting else 14.dp,
                bottomStart = if (isMe) 14.dp else bottomConnecting,
                bottomEnd = if (isMe) bottomConnecting else 14.dp,
            ),
            modifier = Modifier.widthIn(max = 280.dp),
        ) {
            when (message.messageType) {
                "image" -> ImageBubbleContent(message = message, timeLabel = timeLabel, isMe = isMe)
                "voice" -> VoiceBubbleContent(
                    textColor = textColor,
                    timeColor = timeColor,
                    timeLabel = timeLabel,
                    isMe = isMe,
                    isPlaying = isPlaying,
                    isLoading = isLoadingAudio,
                    positionMs = voicePositionMs,
                    durationMs = voiceDurationMs,
                    onTap = onPlayVoice,
                )
                else -> Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    Text(message.body ?: "", color = textColor, style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(3.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(timeLabel, color = timeColor, style = MaterialTheme.typography.labelSmall)
                        if (isMe) {
                            Spacer(Modifier.width(3.dp))
                            Icon(Icons.Filled.Done, contentDescription = null, tint = timeColor, modifier = Modifier.size(13.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ImageBubbleContent(message: SupportMessage, timeLabel: String, isMe: Boolean) {
    var bitmap by remember(message.id) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(message.id) { mutableStateOf(false) }

    LaunchedEffect(message.id) {
        val mediaId = message.id
        try {
            val response = ApiClient.service.getSupportMessageMedia(mediaId)
            val bytes = response.body()?.bytes()
            if (bytes != null) {
                val decoded = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
                bitmap = decoded?.asImageBitmap()
                if (decoded == null) failed = true
            } else {
                failed = true
            }
        } catch (e: Exception) {
            failed = true
        }
    }

    Box(modifier = Modifier.padding(4.dp)) {
        Box(
            modifier = Modifier.size(180.dp).clip(RoundedCornerShape(10.dp)).background(Color.Black.copy(alpha = 0.06f)),
            contentAlignment = Alignment.Center,
        ) {
            val current = bitmap
            when {
                current != null -> Image(
                    bitmap = current,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
                failed -> Icon(Icons.Filled.BrokenImage, contentDescription = null)
                else -> CircularProgressIndicator(strokeWidth = 2.dp)
            }
        }
        Surface(
            color = Color.Black.copy(alpha = 0.45f),
            shape = RoundedCornerShape(6.dp),
            modifier = Modifier.align(Alignment.BottomEnd).padding(6.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            ) {
                Text(timeLabel, color = Color.White, style = MaterialTheme.typography.labelSmall)
                if (isMe) {
                    Spacer(Modifier.width(3.dp))
                    Icon(Icons.Filled.Done, contentDescription = null, tint = Color.White, modifier = Modifier.size(12.dp))
                }
            }
        }
    }
}

private fun formatMs(ms: Int): String {
    val totalSeconds = ms / 1000
    val m = totalSeconds / 60
    val s = totalSeconds % 60
    return "%d:%02d".format(m, s)
}

@Composable
private fun VoiceBubbleContent(
    textColor: Color,
    timeColor: Color,
    timeLabel: String,
    isMe: Boolean,
    isPlaying: Boolean,
    isLoading: Boolean,
    // Only meaningful while isPlaying -- live playback position.
    positionMs: Int,
    // Learned from the file itself on first play (see playVoice); null
    // until then, in which case we show the mic icon alone rather than a
    // fake 0:00.
    durationMs: Int?,
    onTap: () -> Unit,
) {
    val progress = if (isPlaying && durationMs != null && durationMs > 0) {
        (positionMs.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f)
    } else 0f
    val durationLabel = if (isPlaying) {
        "${formatMs(positionMs)} / ${durationMs?.let { formatMs(it) } ?: "--:--"}"
    } else {
        durationMs?.let { formatMs(it) }
    }

    Column(modifier = Modifier.width(200.dp).padding(horizontal = 12.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier.size(30.dp).clickable(enabled = !isLoading, onClick = onTap),
                contentAlignment = Alignment.Center,
            ) {
                if (isLoading) {
                    CircularProgressIndicator(strokeWidth = 2.dp, color = textColor, modifier = Modifier.size(22.dp))
                } else {
                    Icon(
                        if (isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                        contentDescription = if (isPlaying) "Pause" else "Play",
                        tint = textColor,
                        modifier = Modifier.size(28.dp),
                    )
                }
            }
            Spacer(Modifier.width(8.dp))
            Box(modifier = Modifier.weight(1f).height(3.dp)) {
                Box(
                    modifier = Modifier.fillMaxWidth().height(3.dp)
                        .background(textColor.copy(alpha = 0.3f), RoundedCornerShape(2.dp)),
                )
                Box(
                    modifier = Modifier.fillMaxWidth(progress).height(3.dp)
                        .background(textColor, RoundedCornerShape(2.dp)),
                )
            }
            Spacer(Modifier.width(8.dp))
            Icon(Icons.Filled.Mic, contentDescription = null, tint = textColor.copy(alpha = 0.7f), modifier = Modifier.size(15.dp))
        }
        Spacer(Modifier.height(3.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (durationLabel != null) {
                Text(durationLabel, color = timeColor, style = MaterialTheme.typography.labelSmall)
                Spacer(Modifier.width(6.dp))
            }
            Text(timeLabel, color = timeColor, style = MaterialTheme.typography.labelSmall)
            if (isMe) {
                Spacer(Modifier.width(3.dp))
                Icon(Icons.Filled.Done, contentDescription = null, tint = timeColor, modifier = Modifier.size(13.dp))
            }
        }
    }
}
