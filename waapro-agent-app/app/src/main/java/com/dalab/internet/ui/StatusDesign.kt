package com.dalab.internet.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.ui.i18n.Text

/* Shared look for the device-status screens (Permissions, Reliability). */

val StatusGreen = Color(0xFF137A3A)
val StatusRed = Color(0xFFDC2626)
val StatusAmber = Color(0xFF8A6200)

/** One check as a tile: its icon, its name, and a green / red state pill. */
@Composable
fun StatusTile(icon: ImageVector, label: String, ok: Boolean, okLabel: String, notOkLabel: String, modifier: Modifier = Modifier) {
    val ink = if (ok) StatusGreen else StatusRed
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 2.dp,
        modifier = modifier.border(1.dp, if (ok) WaaproBorder else StatusRed.copy(alpha = 0.5f), RoundedCornerShape(20.dp)),
    ) {
        Column(Modifier.padding(14.dp)) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(ink.copy(alpha = 0.12f)), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = ink, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.height(10.dp))
            Text(label, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(8.dp))
            StatePill(if (ok) okLabel else notOkLabel, ink)
        }
    }
}

@Composable
fun StatePill(label: String, ink: Color) {
    Surface(shape = RoundedCornerShape(50), color = ink.copy(alpha = 0.12f)) {
        Text(label, color = ink, fontWeight = FontWeight.Bold, fontSize = 12.sp, maxLines = 1, modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
    }
}

/** Tiles two per row. */
@Composable
fun StatusGrid(tiles: List<@Composable (Modifier) -> Unit>) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        tiles.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                row.forEach { it(Modifier.weight(1f)) }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

/** A titled white card for a section's figures. */
@Composable
fun StatusSection(title: String, content: @Composable () -> Unit) {
    Column {
        Text(title, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, modifier = Modifier.padding(start = 4.dp, bottom = 8.dp))
        Surface(
            shape = RoundedCornerShape(20.dp),
            color = MaterialTheme.colorScheme.surface,
            shadowElevation = 2.dp,
            modifier = Modifier.fillMaxWidth().border(1.dp, WaaproBorder, RoundedCornerShape(20.dp)),
        ) { Column(Modifier.padding(16.dp)) { content() } }
    }
}

/** A big figure with its label under it. */
@Composable
fun StatusFigure(value: String, label: String, modifier: Modifier = Modifier, ink: Color = Color.Unspecified) {
    Column(modifier) {
        Text(value, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp, color = ink, maxLines = 1)
        Text(label, color = WaaproMuted, fontSize = 12.sp)
    }
}

/** The header's summary banner: one line saying whether everything is fine. */
@Composable
fun StatusBanner(text: String, ok: Boolean, warn: Boolean = false) {
    val ink = when { ok -> StatusGreen; warn -> StatusAmber; else -> StatusRed }
    Surface(shape = RoundedCornerShape(16.dp), color = Color.White, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
            Box(Modifier.size(12.dp).clip(CircleShape).background(ink))
            Spacer(Modifier.size(10.dp))
            Text(text, color = ink, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp)
        }
    }
}
