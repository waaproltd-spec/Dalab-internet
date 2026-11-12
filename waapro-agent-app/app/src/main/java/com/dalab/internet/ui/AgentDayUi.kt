package com.dalab.internet.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.data.AgentNotice
import com.dalab.internet.data.AgentToday
import com.dalab.internet.network.AgentDayRepository
import com.dalab.internet.network.NetworkStatus
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.ui.i18n.Text
import com.dalab.internet.ussd.UncertainUssdJobs
import com.dalab.internet.ussd.UssdJobRegistry
import com.dalab.internet.ussd.UssdSimLock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale

private val GreenBg = Color(0xFFE6F6EC)
private val GreenInk = Color(0xFF137A3A)
private val AmberBg = Color(0xFFFFF4D6)
private val AmberInk = Color(0xFF8A6200)
private val RedBg = Color(0xFFFDE2E2)
private val RedInk = Color(0xFFB42318)
private val BlueBg = Color(0xFFE3EEFD)
private val BlueInk = Color(0xFF1450B4)

private fun money(v: Double) = "$" + "%.2f".format(v)

// ---------------------------------------------------------------- Today

/**
 * Home's "Today" section: Orders Created Today, My Performance and Daily
 * Revenue (volume and commission separately) -- straight from
 * GET /agent/today. While offline the last figures stay, marked as such.
 */
@Composable
fun AgentTodaySection(modifier: Modifier = Modifier) {
    val today by AgentDayRepository.today.collectAsState()
    val stale by AgentDayRepository.todayStale.collectAsState()
    val updatedAt by AgentDayRepository.todayUpdatedAt.collectAsState()
    Column(modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.CalendarToday, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text("Today", color = WaaproNavy, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp)
            Spacer(Modifier.weight(1f))
            val time = updatedAt?.let { SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(it)) }
            if (stale && time != null) Text("Offline · updated $time", color = AmberInk, fontSize = 12.sp)
            else if (time != null) Text("Updated $time", color = WaaproMuted, fontSize = 12.sp)
        }
        val t = today
        if (t == null) {
            Text(if (stale) "Could not load today's figures — will retry when online." else "Loading today's figures…", color = WaaproMuted, fontSize = 13.sp)
            return@Column
        }
        OrdersTodayCard(t)
        MyPerformanceCard(t)
        DailyRevenueCard(t)
    }
}

@Composable
private fun DayCard(icon: ImageVector, title: String, content: @Composable () -> Unit) {
    Surface(shape = RoundedCornerShape(16.dp), color = Color.White, modifier = Modifier.fillMaxWidth().border(1.dp, WaaproBorder, RoundedCornerShape(16.dp))) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(title, color = WaaproNavy, fontWeight = FontWeight.Bold, fontSize = 14.sp)
            }
            Spacer(Modifier.height(10.dp))
            content()
        }
    }
}

@Composable
private fun CountTile(label: String, value: String, bg: Color, ink: Color, modifier: Modifier = Modifier) {
    Column(modifier.background(bg, RoundedCornerShape(12.dp)).padding(horizontal = 8.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, color = ink, fontWeight = FontWeight.ExtraBold, fontSize = 18.sp, maxLines = 1)
        Text(label, color = ink, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun OrdersTodayCard(t: AgentToday) {
    val o = t.ordersToday
    DayCard(Icons.Filled.ReceiptLong, "Orders Created Today") {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            CountTile("Total", o.created.toString(), BlueBg, BlueInk, Modifier.weight(1f))
            CountTile("Completed", o.completed.toString(), GreenBg, GreenInk, Modifier.weight(1f))
            CountTile("Pending", o.pending.toString(), AmberBg, AmberInk, Modifier.weight(1f))
            CountTile("Failed", o.failed.toString(), RedBg, RedInk, Modifier.weight(1f))
        }
        if (o.cancelled > 0) {
            Spacer(Modifier.height(6.dp))
            Text("Cancelled or reversed: ${o.cancelled}", color = WaaproMuted, fontSize = 12.sp)
        }
    }
}

@Composable
private fun MyPerformanceCard(t: AgentToday) {
    val m = t.myPerformance
    DayCard(Icons.Filled.Person, "My Performance") {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            CountTile("Successful", m.completed.toString(), GreenBg, GreenInk, Modifier.weight(1f))
            CountTile("Failed", m.failed.toString(), RedBg, RedInk, Modifier.weight(1f))
            CountTile("Pending", m.pending.toString(), AmberBg, AmberInk, Modifier.weight(1f))
        }
        Spacer(Modifier.height(6.dp))
        Text(
            "My orders today: ${m.created} · USSD dials: ${m.dialAttempts} (${m.dialSuccess} ok, ${m.dialFailed} failed)",
            color = WaaproMuted, fontSize = 12.sp,
        )
    }
}

@Composable
private fun DailyRevenueCard(t: AgentToday) {
    val r = t.revenueToday
    DayCard(Icons.Filled.Payments, "Daily Revenue") {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f).background(GreenBg, RoundedCornerShape(12.dp)).padding(10.dp)) {
                Text("Completed volume", color = GreenInk, fontSize = 12.sp)
                Text(money(r.completedVolume), color = GreenInk, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp)
            }
            Column(Modifier.weight(1f).background(BlueBg, RoundedCornerShape(12.dp)).padding(10.dp)) {
                Text("Commission", color = BlueInk, fontSize = 12.sp)
                Text(money(r.commission), color = BlueInk, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp)
            }
        }
        Spacer(Modifier.height(6.dp))
        Text("My orders: ${money(r.myCompletedVolume)} · commission ${money(r.myCommission)}", color = WaaproMuted, fontSize = 12.sp)
    }
}

// ---------------------------------------------------------------- Notices

private val noticeTimeFormat = DateTimeFormatter.ofPattern("EEE d MMM, HH:mm", Locale.ENGLISH)

/** "Sat 14 Nov, 22:00" in the phone's own time zone; null if not a date. */
fun formatNoticeTime(iso: String?): String? = try {
    iso?.let { noticeTimeFormat.format(Instant.parse(it).atZone(ZoneId.systemDefault())) }
} catch (_: Exception) {
    null
}

/** Admin Maintenance Notices at the top of every Home tab. Each can be
 * hidden for this session; a new or changed notice always shows. */
@Composable
fun AgentNoticesBanner(modifier: Modifier = Modifier) {
    val notices by AgentDayRepository.notices.collectAsState()
    val hidden = remember { mutableStateListOf<String>() }
    val visible = notices.filter { (it.id + it.title + it.message) !in hidden }
    if (visible.isEmpty()) return
    Column(modifier.fillMaxWidth()) {
        visible.forEach { n -> NoticeRow(n) { hidden.add(n.id + n.title + n.message) } }
    }
}

@Composable
private fun NoticeRow(n: AgentNotice, onHide: () -> Unit) {
    var expanded by remember(n.id) { mutableStateOf(n.phase == "active") }
    val (bg, ink, icon) = when (n.kind) {
        "warning" -> Triple(RedBg, RedInk, Icons.Filled.Warning)
        "info" -> Triple(BlueBg, BlueInk, Icons.Filled.Info)
        else -> Triple(AmberBg, AmberInk, Icons.Filled.Build)
    }
    Column(
        Modifier.fillMaxWidth().background(bg).clickable { expanded = !expanded }.padding(start = 14.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = ink, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(n.title, color = ink, fontWeight = FontWeight.Bold, fontSize = 13.5.sp, maxLines = if (expanded) 3 else 1, overflow = TextOverflow.Ellipsis)
                val starts = formatNoticeTime(n.startsAt)
                val ends = formatNoticeTime(n.endsAt)
                val whenText = when {
                    n.phase == "scheduled" && starts != null -> "Scheduled: $starts" + (ends?.let { " – $it" } ?: "")
                    ends != null -> "Until $ends"
                    else -> null
                }
                if (whenText != null) Text(whenText, color = ink, fontSize = 12.sp)
            }
            Box(Modifier.size(36.dp).clickable(onClick = onHide), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Close, contentDescription = "Hide", tint = ink, modifier = Modifier.size(18.dp))
            }
        }
        AnimatedVisibility(visible = expanded) {
            Text(n.message, color = ink, fontSize = 13.sp, modifier = Modifier.padding(start = 26.dp, end = 10.dp, top = 4.dp))
        }
    }
}

// ---------------------------------------------------------------- Connection

/**
 * Connection recovery: shows when the phone is offline, what happens to
 * USSD results meanwhile (saved on the phone, sent when back online), the
 * catch-up after reconnecting, and every transaction whose result is
 * UNKNOWN -- which the app never dials again by itself.
 */
@Composable
fun ConnectionRecoveryBanner(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val online by NetworkStatus.online.collectAsState()
    val activeKeys by UssdJobRegistry.activeKeys.collectAsState()
    val timedOut by UncertainUssdJobs.entries.collectAsState()
    val queue by UssdSimLock.status.collectAsState()
    var pending by remember { mutableStateOf(0) }
    var justReconnected by remember { mutableStateOf(false) }
    var interrupted by remember { mutableStateOf(emptyList<UncertainUssdJobs.Entry>()) }

    // Saved results waiting to be sent, and dials interrupted mid-flight.
    LaunchedEffect(activeKeys, queue.running) {
        while (true) {
            withContext(Dispatchers.IO) {
                pending = try { PendingActionQueue.all().size } catch (_: Exception) { 0 }
                interrupted = try { UncertainUssdJobs.interruptedDials(context, activeKeys) } catch (_: Exception) { emptyList() }
            }
            delay(3_000L)
        }
    }
    LaunchedEffect(Unit) {
        NetworkStatus.reconnected.collect {
            justReconnected = true
        }
    }
    LaunchedEffect(justReconnected, pending) {
        if (justReconnected && pending == 0) {
            delay(4_000L)
            justReconnected = false
        }
    }

    val uncertain = (interrupted + timedOut.filter { e -> interrupted.none { it.key == e.key } && e.key !in activeKeys })
    Column(modifier.fillMaxWidth()) {
        if (!online) {
            StatusStrip(Icons.Filled.CloudOff, RedBg, RedInk, "No internet connection",
                "USSD results are saved on this phone and sent when you're back online. Nothing is dialed again automatically." +
                    if (pending > 0) " Saved: $pending." else "")
        } else if (justReconnected) {
            if (pending > 0) StatusStrip(Icons.Filled.CloudDone, AmberBg, AmberInk, "Back online", "Sending $pending saved result(s)…")
            else StatusStrip(Icons.Filled.CloudDone, GreenBg, GreenInk, "Back online", "Orders and USSD status are up to date.")
        }
        uncertain.forEach { e ->
            Row(
                Modifier.fillMaxWidth().background(AmberBg).padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.ErrorOutline, contentDescription = null, tint = AmberInk, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text("Check before retrying: ${e.label}", color = AmberInk, fontWeight = FontWeight.Bold, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        if (e.reason == UncertainUssdJobs.REASON_TIMEOUT) "USSD timed out on SIM ${e.simSlot} — the result is unknown. It was not dialed again."
                        else "The app stopped during this USSD on SIM ${e.simSlot} — the result is unknown. It will not be dialed again automatically.",
                        color = AmberInk, fontSize = 12.sp,
                    )
                }
                if (e.reason == UncertainUssdJobs.REASON_TIMEOUT) {
                    TextButton(onClick = { UncertainUssdJobs.dismiss(e.key) }) { Text("Checked", color = AmberInk, fontWeight = FontWeight.Bold) }
                }
            }
        }
    }
}

@Composable
private fun StatusStrip(icon: ImageVector, bg: Color, ink: Color, title: String, body: String) {
    Row(Modifier.fillMaxWidth().background(bg).padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = ink, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = ink, fontWeight = FontWeight.Bold, fontSize = 13.5.sp)
            Text(body, color = ink, fontSize = 12.sp)
        }
    }
}
