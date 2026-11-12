package com.dalab.internet.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.data.OtherAgent
import com.dalab.internet.network.ApiClient
import com.dalab.internet.ui.i18n.Text
import kotlinx.coroutines.delay
import java.time.Duration
import java.time.Instant

private val OnlineGreen = Color(0xFF16A34A)
private val OnlineBg = Color(0xFFE6F6EC)
private val OfflineRed = Color(0xFFDC2626)
private val OfflineBg = Color(0xFFFDE2E2)

/** "5 min ago", "2 h ago", "3 days ago"; null if unknown. */
fun lastSeenText(iso: String?, now: Instant = Instant.now()): String? {
    val t = try { iso?.let { Instant.parse(it) } } catch (_: Exception) { null } ?: return null
    val mins = Duration.between(t, now).toMinutes().coerceAtLeast(0)
    return when {
        mins < 1 -> "just now"
        mins < 60 -> "$mins min ago"
        mins < 60 * 24 -> "${mins / 60} h ago"
        else -> "${mins / (60 * 24)} days ago"
    }
}

/**
 * Other Agents: every other active agent of this system, ONLINE (green) or
 * OFFLINE (red), from the server's last-seen times. Refreshes every 30s
 * and as you type in the search box. Phone numbers appear only when the
 * system allows it -- the server doesn't send them otherwise.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OtherAgentsScreen(onBack: () -> Unit) {
    var search by remember { mutableStateOf("") }
    var agents by remember { mutableStateOf<List<OtherAgent>>(emptyList()) }
    var phoneVisible by remember { mutableStateOf(false) }
    var onlineCount by remember { mutableStateOf(0) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(search) {
        if (search.isNotEmpty()) delay(350) // wait for typing to pause
        while (true) {
            try {
                val res = ApiClient.service.getOtherAgents(search.trim().ifEmpty { null })
                val body = res.body()
                if (res.isSuccessful && body != null) {
                    agents = body.agents
                    phoneVisible = body.phoneVisible
                    onlineCount = body.onlineCount
                    error = null
                } else {
                    error = "Could not load agents (${res.code()})."
                }
            } catch (_: Exception) {
                error = "No connection — showing the last list."
            }
            loaded = true
            delay(30_000L)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Other Agents", fontWeight = FontWeight.Bold) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OutlinedTextField(
                value = search,
                onValueChange = { search = it.take(60) },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                placeholder = { Text(if (phoneVisible) "Search by name or work phone" else "Search by name") },
                singleLine = true,
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
            Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(9.dp).background(OnlineGreen, CircleShape))
                Spacer(Modifier.width(6.dp))
                Text("$onlineCount online", color = WaaproNavy, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                Spacer(Modifier.width(12.dp))
                Text("${agents.size} agents", color = WaaproMuted, fontSize = 13.sp)
            }
            error?.let { Text(it, color = OfflineRed, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp)) }
            when {
                !loaded -> Text("Loading…", color = WaaproMuted, modifier = Modifier.padding(16.dp))
                agents.isEmpty() -> Text(if (search.isBlank()) "No other agents in this system yet." else "No agent matches your search.", color = WaaproMuted, modifier = Modifier.padding(16.dp))
                else -> LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(agents, key = { it.id }) { AgentRow(it) }
                }
            }
        }
    }
}

@Composable
private fun AgentRow(a: OtherAgent) {
    val online = a.online
    Surface(shape = RoundedCornerShape(14.dp), color = Color.White, modifier = Modifier.fillMaxWidth().border(1.dp, WaaproBorder, RoundedCornerShape(14.dp))) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(12.dp).background(if (online) OnlineGreen else OfflineRed, CircleShape))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(a.name, color = WaaproNavy, fontWeight = FontWeight.Bold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                a.phone?.let {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Phone, contentDescription = null, tint = WaaproMuted, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(4.dp))
                        Text(it, color = WaaproInk, fontSize = 13.sp)
                    }
                }
                if (!online) lastSeenText(a.lastSeenAt)?.let { Text("Last seen $it", color = WaaproMuted, fontSize = 12.sp) }
            }
            Surface(shape = RoundedCornerShape(50), color = if (online) OnlineBg else OfflineBg) {
                Text(
                    if (online) "ONLINE" else "OFFLINE",
                    color = if (online) OnlineGreen else OfflineRed,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
                )
            }
        }
    }
}
