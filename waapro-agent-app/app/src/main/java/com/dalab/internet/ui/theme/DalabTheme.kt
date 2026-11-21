package com.dalab.internet.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

/**
 * The Material3 color schemes the whole app renders through --
 * MainActivity's one DalabTheme { AgentApp() } call is the only place this
 * is wired in. Every stock Material3 component (Button, Switch, TextField,
 * NavigationBar, Dialog, ...) reads its colors from these roles, and the
 * Dalab* colors in DalabColors.kt follow the same Light/Dark and Theme
 * color choice. error stays a real red in both: it's a status color, not
 * brand decoration.
 */
fun dalabColorScheme(p: AgentPalette = currentAgentPalette): ColorScheme {
    val onBrandFill = AgentLightPalette.white
    return if (!p.dark) {
        lightColorScheme(
            primary = p.brandFill,
            onPrimary = onBrandFill,
            primaryContainer = p.softBlue,
            onPrimaryContainer = p.blue,
            secondary = p.brandFill,
            onSecondary = onBrandFill,
            secondaryContainer = p.softBlue,
            onSecondaryContainer = p.blue,
            tertiary = p.brandFill,
            onTertiary = onBrandFill,
            tertiaryContainer = p.softBlue,
            onTertiaryContainer = p.blue,
            background = p.white,
            onBackground = p.blue,
            surface = p.white,
            onSurface = p.blue,
            surfaceVariant = p.surfaceTint,
            onSurfaceVariant = p.blue,
            surfaceTint = p.brandFill,
            inverseSurface = p.brandFill,
            inverseOnSurface = onBrandFill,
            inversePrimary = p.softBlue,
            outline = p.outline,
            outlineVariant = p.surfaceTint,
            error = p.danger,
            onError = onBrandFill,
            errorContainer = p.dangerContainer,
            onErrorContainer = p.danger,
        )
    } else {
        darkColorScheme(
            primary = p.brandFillLight,
            onPrimary = onBrandFill,
            primaryContainer = p.softBlue,
            onPrimaryContainer = p.blue,
            secondary = p.brandFillLight,
            onSecondary = onBrandFill,
            secondaryContainer = p.softBlue,
            onSecondaryContainer = p.blue,
            tertiary = p.brandFillLight,
            onTertiary = onBrandFill,
            tertiaryContainer = p.softBlue,
            onTertiaryContainer = p.blue,
            background = p.white,
            onBackground = p.blue,
            surface = p.white,
            onSurface = p.blue,
            surfaceVariant = p.surfaceTint,
            onSurfaceVariant = p.blue,
            surfaceTint = p.brandFillLight,
            inverseSurface = p.blue,
            inverseOnSurface = p.white,
            inversePrimary = p.brandFill,
            outline = p.outline,
            outlineVariant = p.surfaceTint,
            error = p.danger,
            onError = p.white,
            errorContainer = p.dangerContainer,
            onErrorContainer = p.danger,
        )
    }
}

@Composable
fun DalabTheme(content: @Composable () -> Unit) {
    // Reads AgentSettings (theme mode, phone setting, Theme color), so any
    // change recolors the app at once.
    MaterialTheme(colorScheme = dalabColorScheme(), content = content)
}
