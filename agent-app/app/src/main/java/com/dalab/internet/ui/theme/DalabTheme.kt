package com.dalab.internet.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

/**
 * The single Material3 ColorScheme the whole app renders through --
 * MainActivity's one DalabTheme { AgentApp() } call is the only place this
 * is wired in. Every stock Material3 component (Button, Switch, Checkbox,
 * TextField, NavigationBar, Dialog, FilterChip, ...) reads its color from
 * these same roles automatically, with zero per-screen overrides needed --
 * this is what makes "Blue + White everywhere, controlled from one place"
 * actually true for the ~30 screens in this app that call plain
 * Button()/TextField()/etc. without their own color overrides (previously
 * these all fell back to Material3's own default lavender/purple scheme,
 * since the app never supplied a colorScheme at all).
 *
 * Deliberately a single fixed scheme, not light/dark-mode-aware -- the app
 * never branched on isSystemInDarkTheme() before this, so this preserves
 * that exact behavior rather than introducing dark mode as unrequested
 * scope. error/errorContainer stay a real red (not blue) -- that's a
 * functional status color, not brand decoration; a blue "something failed"
 * state would be confusing, not on-brand.
 */
val DalabColorScheme = lightColorScheme(
    primary = DalabBlue,
    onPrimary = DalabWhite,
    primaryContainer = DalabSoftBlue,
    onPrimaryContainer = DalabBlue,
    secondary = DalabBlue,
    onSecondary = DalabWhite,
    secondaryContainer = DalabSoftBlue,
    onSecondaryContainer = DalabBlue,
    tertiary = DalabBlue,
    onTertiary = DalabWhite,
    tertiaryContainer = DalabSoftBlue,
    onTertiaryContainer = DalabBlue,
    background = DalabWhite,
    onBackground = DalabBlue,
    surface = DalabWhite,
    onSurface = DalabBlue,
    surfaceVariant = DalabSurfaceTint,
    onSurfaceVariant = DalabBlue,
    surfaceTint = DalabBlue,
    inverseSurface = DalabBlue,
    inverseOnSurface = DalabWhite,
    inversePrimary = DalabSoftBlue,
    outline = DalabOutline,
    outlineVariant = DalabSurfaceTint,
    error = DalabDangerRed,
    onError = DalabWhite,
    errorContainer = DalabDangerRedContainer,
    onErrorContainer = DalabDangerRed,
)

@Composable
fun DalabTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DalabColorScheme, content = content)
}
