package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.R

/** The app's official name, the same for every system's agents. */
const val WAAPRO_APP_NAME = "WAAPRO LTD AGENT"

// WAAPRO LTD colours: navy, royal blue, white and gold (from the logo).
val WaaproNavy = Color(0xFF0B2A6B)
val WaaproBlue = Color(0xFF1565D8)
val WaaproGold = Color(0xFFF5B800)
val WaaproBg = Color(0xFFF4F7FC)
val WaaproInk = Color(0xFF1B2333)
val WaaproMuted = Color(0xFF5B6475)
val WaaproBorder = Color(0xFFD5DCE8)
val WaaproSoft = Color(0xFFE3EEFD)

/** The official WAAPRO LTD logo (res/drawable/waapro_ltd_logo.png, unchanged) with the company name under it. */
@Composable
fun WaaproLogoBlock(logoSize: Dp = 120.dp, nameSize: TextUnit = 30.sp) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Image(
            painter = painterResource(R.drawable.waapro_ltd_logo),
            contentDescription = "WAAPRO LTD",
            modifier = Modifier.size(logoSize),
        )
        Text("WAAPRO LTD", color = WaaproNavy, fontSize = nameSize, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp)
    }
}

/** The navy pill with "WAAPRO LTD AGENT". */
@Composable
fun WaaproAgentPill(textSize: TextUnit = 22.sp) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(Brush.horizontalGradient(listOf(WaaproNavy, WaaproBlue)))
            .padding(horizontal = 24.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.SupportAgent, contentDescription = null, tint = Color.White, modifier = Modifier.size(26.dp))
        Spacer(Modifier.width(10.dp))
        Text(WAAPRO_APP_NAME, color = Color.White, fontSize = textSize, fontWeight = FontWeight.Bold)
    }
}

/** The navy-and-gold curves at the top and bottom of the branded screens. */
@Composable
fun WaaproWaves(modifier: Modifier = Modifier.fillMaxSize()) {
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val top = Path().apply {
            moveTo(0f, 0f)
            lineTo(w * 0.62f, 0f)
            cubicTo(w * 0.40f, h * 0.02f, w * 0.22f, h * 0.10f, 0f, h * 0.12f)
            close()
        }
        drawPath(top, Brush.linearGradient(listOf(WaaproNavy, WaaproBlue), Offset(0f, 0f), Offset(w * 0.6f, h * 0.12f)))
        val topGold = Path().apply {
            moveTo(w * 0.62f, 0f)
            cubicTo(w * 0.40f, h * 0.02f, w * 0.22f, h * 0.10f, 0f, h * 0.12f)
        }
        drawPath(topGold, WaaproGold, style = Stroke(width = 5.dp.toPx()))
        val bottom = Path().apply {
            moveTo(0f, h)
            lineTo(0f, h * 0.95f)
            cubicTo(w * 0.35f, h * 1.0f, w * 0.65f, h * 0.89f, w, h * 0.91f)
            lineTo(w, h)
            close()
        }
        drawPath(bottom, Brush.linearGradient(listOf(WaaproBlue, WaaproNavy), Offset(0f, h * 0.9f), Offset(w, h)))
        val bottomGold = Path().apply {
            moveTo(0f, h * 0.95f)
            cubicTo(w * 0.35f, h * 1.0f, w * 0.65f, h * 0.89f, w, h * 0.91f)
        }
        drawPath(bottomGold, WaaproGold, style = Stroke(width = 5.dp.toPx()))
    }
}
