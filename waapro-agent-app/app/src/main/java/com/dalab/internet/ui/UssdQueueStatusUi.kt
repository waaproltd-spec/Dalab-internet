package com.dalab.internet.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.HourglassTop
import androidx.compose.material.icons.filled.PhoneInTalk
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.ui.i18n.Text
import com.dalab.internet.ussd.UssdJobState
import com.dalab.internet.ussd.UssdSimLock

/** Colours for the queue's two states. */
private val RunningBg = Color(0xFFE6F6EC)
private val RunningInk = Color(0xFF137A3A)
private val WaitingBg = Color(0xFFFFF4D6)
private val WaitingInk = Color(0xFF8A6200)

/**
 * App-wide USSD queue banner: what is Running now (only ever one) and what
 * is Waiting, in order. Shown on every Home tab; hidden when idle.
 */
@Composable
fun UssdQueueBanner(modifier: Modifier = Modifier) {
    val status by UssdSimLock.status.collectAsState()
    AnimatedVisibility(visible = !status.isIdle, modifier = modifier) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(WaaproNavy)
                .padding(horizontal = 14.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            val running = status.running
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.PhoneInTalk, contentDescription = null, tint = WaaproGold, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("USSD", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                Spacer(Modifier.width(8.dp))
                if (running != null) {
                    QueuePill("Running", RunningBg, RunningInk)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "${running.label} · SIM ${running.simSlot}",
                        color = Color.White,
                        fontSize = 13.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                } else {
                    QueuePill("Starting", RunningBg, RunningInk)
                    Spacer(Modifier.weight(1f))
                }
            }
            if (status.waiting.isNotEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.HourglassTop, contentDescription = null, tint = WaaproGold, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    QueuePill("Waiting", WaitingBg, WaitingInk)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        status.waiting.mapIndexed { i, e -> "${i + 1}. ${e.label}" }.joinToString("   "),
                        color = Color.White.copy(alpha = 0.9f),
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

/**
 * "Running" / "Waiting #2" pill for one job (e.g. "internet_store:ORDER_ID"),
 * or nothing when that job isn't in the USSD queue.
 */
@Composable
fun UssdJobPill(jobKey: String, modifier: Modifier = Modifier) {
    val status by UssdSimLock.status.collectAsState()
    when (val s = status.stateOf(jobKey)) {
        UssdJobState.Running -> Box(modifier) { QueuePill("Running", RunningBg, RunningInk) }
        is UssdJobState.Waiting -> Box(modifier) { QueuePill("Waiting #${s.position}", WaitingBg, WaitingInk) }
        UssdJobState.None -> Unit
    }
}

/**
 * One line for a detail screen: "USSD Running on SIM 1" or "Waiting in the
 * USSD queue — 2 of 3 (Order X is running)". Nothing when not queued.
 */
@Composable
fun UssdJobStatusLine(jobKey: String, modifier: Modifier = Modifier) {
    val status by UssdSimLock.status.collectAsState()
    val state = status.stateOf(jobKey)
    if (state == UssdJobState.None) return
    val running = state == UssdJobState.Running
    Surface(shape = RoundedCornerShape(12.dp), color = if (running) RunningBg else WaitingBg, modifier = modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Icon(
                if (running) Icons.Filled.PhoneInTalk else Icons.Filled.HourglassTop,
                contentDescription = null,
                tint = if (running) RunningInk else WaitingInk,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                if (running) {
                    Text("USSD running now", color = RunningInk, fontWeight = FontWeight.Bold)
                    status.running?.let { Text("SIM ${it.simSlot}", color = RunningInk, fontSize = 12.sp) }
                } else {
                    val w = state as UssdJobState.Waiting
                    Text("Waiting in the USSD queue", color = WaitingInk, fontWeight = FontWeight.Bold)
                    Text("Position ${w.position} of ${w.total}", color = WaitingInk, fontSize = 12.sp)
                    status.running?.let { Text("Running now: ${it.label}", color = WaitingInk, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            }
        }
    }
}

@Composable
private fun QueuePill(text: String, bg: Color, ink: Color) {
    Surface(shape = RoundedCornerShape(50), color = bg) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp)) {
            Box(Modifier.size(7.dp).background(ink, CircleShape))
            Spacer(Modifier.width(5.dp))
            Text(text, color = ink, fontWeight = FontWeight.Bold, fontSize = 12.sp)
        }
    }
}
