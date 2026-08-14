package com.dalab.internet.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Same brand palette already defined in res/values/colors.xml (dalab_indigo,
 * dalab_green, dalab_ink, dalab_bg) and shared byte-for-byte with the
 * Customer App (kDalabIndigo/kBrandBarColor in app_colors.dart) and the
 * Admin Dashboard (INDIGO/INDIGO_SOFT in App.jsx) -- defined here again as
 * Compose Color values rather than reading the XML resources at runtime
 * because Compose's ColorScheme needs plain Color, not a resource lookup,
 * for every one of its ~25 slots. Keep these in sync with colors.xml if the
 * brand palette ever changes.
 */
object DalabColors {
    val Indigo = Color(0xFF1D2E8C)
    val IndigoDark = Color(0xFF16209E)
    val IndigoSoft = Color(0xFFEEF0FB)
    val Green = Color(0xFF22B24C)
    val Ink = Color(0xFF0B1240)
    val Bg = Color(0xFFF5F6FB)
    val Danger = Color(0xFFC81E2C)
    val Surface = Color(0xFFFFFFFF)
}

private val DalabColorScheme = lightColorScheme(
    primary = DalabColors.Indigo,
    onPrimary = Color.White,
    primaryContainer = DalabColors.IndigoSoft,
    onPrimaryContainer = DalabColors.Indigo,
    secondary = DalabColors.Green,
    onSecondary = Color.White,
    background = DalabColors.Bg,
    onBackground = DalabColors.Ink,
    surface = DalabColors.Surface,
    onSurface = DalabColors.Ink,
    surfaceVariant = DalabColors.IndigoSoft,
    onSurfaceVariant = DalabColors.Indigo,
    error = DalabColors.Danger,
    onError = Color.White,
    outline = Color(0xFFDDE1F0),
)

private val DalabTypography = Typography().let { base ->
    base.copy(
        headlineSmall = base.headlineSmall.copy(fontWeight = FontWeight.Bold, color = DalabColors.Ink),
        titleLarge = base.titleLarge.copy(fontWeight = FontWeight.Bold, color = DalabColors.Ink),
        titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold, color = DalabColors.Ink),
        bodyMedium = base.bodyMedium.copy(color = DalabColors.Ink),
        labelLarge = base.labelLarge.copy(fontWeight = FontWeight.SemiBold),
    )
}

/** Section eyebrow style ("MAIN SERVICES"-style label) used by the redesigned
 * Home/More screens for a consistent, understated section heading. */
val DalabEyebrowStyle = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp)

@Composable
fun DalabTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DalabColorScheme,
        typography = DalabTypography,
        content = content,
    )
}
