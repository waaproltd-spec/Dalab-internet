package com.sahal.data.customer.ui

import android.os.Build
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Same brand blue used everywhere else in the app (ui/Theme.kt's SahalDataIndigo /
// dark-theme primary) so the nav bar's gradient stays on-brand rather than
// introducing an unrelated color pair.
private val GlassStart = Color(0xFF1B368D)
private val GlassEnd = Color(0xFF4C63D6)
private val GlowColor = Color(0xFF6C8CFF)

/**
 * One tab in [PremiumBottomNav]. Deliberately decoupled from any
 * screen-navigation enum so this component is a pure drop-in visual
 * replacement wherever a bottom nav is needed.
 */
data class BottomNavItem(
    val label: String,
    val selectedIcon: ImageVector,
    val unselectedIcon: ImageVector,
    val selected: Boolean,
    val onClick: () -> Unit,
)

/**
 * Floating glassmorphism-style bottom navigation bar: gradient-tinted glass
 * pill, soft shadow, a subtle top-edge highlight border, animated icon
 * scale/tint, and a breathing glow behind the active tab.
 *
 * Real backdrop blur (blurring whatever scrolls behind the bar) isn't
 * available at this app's minSdk 26 without a third-party layer-capture
 * library, so this fakes "glass" the safe way instead: gradient +
 * translucency + shadow + border highlight, which is the same floating-card
 * language already used elsewhere in this app. `Modifier.blur` is applied to
 * the bar's own background layer only on API 31+ as a pure progressive
 * enhancement — omitted below that so nothing looks broken on older devices.
 */
@Composable
fun PremiumBottomNav(items: List<BottomNavItem>) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        // Decorative glass layer only — shadow/gradient/blur/border live here,
        // entirely separate from the icon/label content below. Blurring this
        // box alone (rather than wrapping the Row that contains it) is what
        // keeps the icons and labels sharp: a blur modifier blurs everything
        // drawn inside it, so it must never wrap real content.
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(72.dp)
                .shadow(
                    elevation = 18.dp,
                    shape = RoundedCornerShape(28.dp),
                    ambientColor = GlassStart.copy(alpha = 0.35f),
                    spotColor = GlassStart.copy(alpha = 0.45f),
                )
                .clip(RoundedCornerShape(28.dp))
                .then(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Modifier.blur(20.dp) else Modifier)
                .background(Brush.linearGradient(listOf(GlassStart.copy(alpha = 0.92f), GlassEnd.copy(alpha = 0.82f))))
                .background(Color.White.copy(alpha = 0.06f))
                .border(
                    width = 1.dp,
                    brush = Brush.linearGradient(listOf(Color.White.copy(alpha = 0.35f), Color.White.copy(alpha = 0.05f))),
                    shape = RoundedCornerShape(28.dp),
                ),
        )

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(72.dp)
                .padding(horizontal = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            items.forEach { item -> NavTab(item, modifier = Modifier.weight(1f)) }
        }
    }
}

@Composable
private fun NavTab(item: BottomNavItem, modifier: Modifier = Modifier) {
    val scale by animateFloatAsState(
        targetValue = if (item.selected) 1.15f else 1f,
        animationSpec = tween(220, easing = FastOutSlowInEasing),
        label = "navIconScale",
    )
    val tint by animateColorAsState(
        targetValue = if (item.selected) Color.White else Color.White.copy(alpha = 0.55f),
        animationSpec = tween(220),
        label = "navIconTint",
    )
    val labelAlpha by animateFloatAsState(
        targetValue = if (item.selected) 1f else 0f,
        animationSpec = tween(220),
        label = "navLabelAlpha",
    )
    val interactionSource = remember { MutableInteractionSource() }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .clickable(interactionSource = interactionSource, indication = null, onClick = item.onClick),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(contentAlignment = Alignment.Center) {
                if (item.selected) GlowHalo()
                Icon(
                    imageVector = if (item.selected) item.selectedIcon else item.unselectedIcon,
                    contentDescription = item.label,
                    tint = tint,
                    modifier = Modifier
                        .size(24.dp)
                        .scale(scale),
                )
            }
            Text(
                text = item.label,
                color = tint,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.alpha(labelAlpha),
            )
        }
    }
}

/**
 * Soft breathing glow behind the active tab's icon — built from a radial
 * gradient circle rather than real blur, so it looks the same on every API
 * level (not just 31+).
 */
@Composable
private fun GlowHalo() {
    val infinite = rememberInfiniteTransition(label = "navGlow")
    val pulse by infinite.animateFloat(
        initialValue = 0.85f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1600, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "navGlowPulse",
    )
    Box(
        modifier = Modifier
            .size(46.dp)
            .scale(pulse)
            .background(
                brush = Brush.radialGradient(listOf(GlowColor.copy(alpha = 0.45f), GlowColor.copy(alpha = 0f))),
                shape = CircleShape,
            ),
    )
}
