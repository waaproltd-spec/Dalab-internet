package com.sahal.data.customer.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val BrandGreen = Color(0xFF16A34A)

private val LightColors = lightColorScheme(
    primary = Color(0xFF1D2E8C),
    secondary = BrandGreen,
    background = Color(0xFFF7F8FC),
    surface = Color.White,
    onBackground = Color(0xFF14162B),
    onSurface = Color(0xFF14162B),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF8C9BF0),
    secondary = BrandGreen,
    background = Color(0xFF0B0F1E),
    surface = Color(0xFF141A2E),
    onBackground = Color(0xFFE7E9F5),
    onSurface = Color(0xFFE7E9F5),
)

/**
 * App-wide Light/Dark wrapper driven by [com.sahal.data.customer.prefs.ThemeManager].
 * Screens that are deliberately dark-always (Checkout, Payment Success —
 * per earlier explicit design requests) hardcode their own background and
 * are unaffected either way; everything else follows this scheme.
 */
@Composable
fun SahalDataTheme(darkTheme: Boolean, content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}
