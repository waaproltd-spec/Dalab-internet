package com.dalab.internet.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp

/**
 * DALAB AGENT's own two-color brand system -- Dark Blue + White, the exact
 * same Dark Azure (#003152) the Customer App and Admin Dashboard already
 * use as their shared brand color (see those apps' own AppPalette/App.jsx
 * -- this hex isn't a new choice, it's the one the whole DALAB product
 * family already agreed on). Every screen in this app should read its
 * colors from DalabColorScheme (Theme.kt) rather than a local hardcoded
 * Color(0x...) literal -- that's what actually makes "change the brand
 * color in one place" true; a value copy-pasted into a dozen files can't be
 * centrally controlled no matter how identical the hex looks today.
 *
 * DalabSuccessGreen/DalabWarningAmber/DalabDangerRed/DalabInfoBlue below are
 * deliberately NOT part of the brand palette -- they're functional status
 * colors (a completed order, a low balance, a failed dial attempt), the
 * same carve-out the Customer App and Admin Dashboard both already
 * document for their own two-color rule. Keeping them separate means a
 * future rebrand only ever touches DalabBlue/DalabSoftBlue, never a status
 * color that happens to live in the same file.
 */
/**
 * The palette every Dalab* color reads: Light or Dark mode (More →
 * Appearance & Language → Theme) and the Theme color. The Dalab* names are
 * getters over Compose state, so a screen that reads them redraws the
 * moment either setting changes -- and they work anywhere, not only inside
 * a @Composable.
 *
 *  - [DalabBlue]: the brand color for TEXT and ICONS on the page (navy in
 *    Light, a light blue in Dark, so it stays readable);
 *  - [DalabBrandFill]: the brand color as a FILL with white text/icons on
 *    it (buttons, headers, selected chips) -- deep in both modes;
 *  - [DalabWhite] / [DalabSurfaceTint]: page and card backgrounds;
 *  - [DalabSoftBlue]: pale brand tint behind icons and highlights;
 *  - [DalabMuted] / [DalabFaint]: grey secondary text and hints.
 * Status colors (success/warning/danger/info) keep their meaning in both
 * modes, a little lighter in Dark.
 */
data class AgentPalette(
    val blue: Color,
    val brandFill: Color,
    val brandFillLight: Color,
    val softBlue: Color,
    val white: Color,
    val surfaceTint: Color,
    val outline: Color,
    val success: Color,
    val warning: Color,
    val danger: Color,
    val dangerContainer: Color,
    val info: Color,
    val muted: Color,
    val faint: Color,
    val dark: Boolean = false,
)

/** DALAB Navy in Light mode -- exactly the original colors. */
val AgentLightPalette = AgentPalette(
    blue = Color(0xFF003152),
    brandFill = Color(0xFF003152),
    brandFillLight = Color(0xFFADDFF1),
    softBlue = Color(0xFFADDFF1),
    white = Color(0xFFFFFFFF),
    surfaceTint = Color(0xFFF3F8FB),
    outline = Color(0xFFB9CBD6),
    success = Color(0xFF16A34A),
    warning = Color(0xFFF2C200),
    danger = Color(0xFFC81E2C),
    dangerContainer = Color(0xFFFEE2E2),
    info = Color(0xFF1D4ED8),
    muted = Color(0xFF6B7280),
    faint = Color(0xFF9CA3AF),
)

/** DALAB Navy in Dark mode. */
val AgentDarkPalette = AgentPalette(
    blue = Color(0xFFCFE3F7),
    brandFill = Color(0xFF1B5A93),
    brandFillLight = Color(0xFF2E78B8),
    softBlue = Color(0xFF2A4A6E),
    white = Color(0xFF0F1626),
    surfaceTint = Color(0xFF18233A),
    outline = Color(0xFF3A4A66),
    success = Color(0xFF34D399),
    warning = Color(0xFFF2C200),
    danger = Color(0xFFF87171),
    dangerContainer = Color(0xFF3B1219),
    info = Color(0xFF60A5FA),
    muted = Color(0xFFA3ACBE),
    faint = Color(0xFF7C879C),
    dark = true,
)

/**
 * The palette for [accent] in Light or Dark mode. DALAB Navy is the
 * hand-tuned pair above; every other color swaps only the brand roles and
 * keeps the neutral and status colors, so white text stays readable on
 * every fill.
 */
fun agentPalette(accent: AgentAccent, dark: Boolean): AgentPalette {
    val base = if (dark) AgentDarkPalette else AgentLightPalette
    if (accent == AgentAccent.DALAB_NAVY) return base
    val c = accent.color
    return if (!dark) {
        base.copy(blue = c, brandFill = c, brandFillLight = lerp(c, Color.White, 0.55f), softBlue = lerp(c, Color.White, 0.65f))
    } else {
        base.copy(
            blue = lerp(c, Color.White, 0.7f),
            brandFill = c,
            brandFillLight = lerp(c, Color.White, 0.12f),
            softBlue = lerp(c, base.white, 0.55f),
        )
    }
}

/** The palette for the agent's current settings. */
val currentAgentPalette: AgentPalette get() = agentPalette(AgentSettings.accent, AgentSettings.isDark)

val DalabBlue: Color get() = currentAgentPalette.blue
val DalabBrandFill: Color get() = currentAgentPalette.brandFill
val DalabBrandFillLight: Color get() = currentAgentPalette.brandFillLight
val DalabSoftBlue: Color get() = currentAgentPalette.softBlue
val DalabWhite: Color get() = currentAgentPalette.white
val DalabSurfaceTint: Color get() = currentAgentPalette.surfaceTint
val DalabOutline: Color get() = currentAgentPalette.outline
val DalabSuccessGreen: Color get() = currentAgentPalette.success
val DalabWarningAmber: Color get() = currentAgentPalette.warning
val DalabDangerRed: Color get() = currentAgentPalette.danger
val DalabDangerRedContainer: Color get() = currentAgentPalette.dangerContainer
val DalabInfoBlue: Color get() = currentAgentPalette.info
val DalabMuted: Color get() = currentAgentPalette.muted
val DalabFaint: Color get() = currentAgentPalette.faint

/** True while Dark mode is on. */
val isAgentDark: Boolean get() = AgentSettings.isDark

/**
 * The colors an agent can pick under More → Appearance & Language → Theme
 * color: DALAB Navy (the default, the original look) plus the same 12
 * accent colors the Customer App offers.
 */
enum class AgentAccent(val label: String, val color: Color) {
    DALAB_NAVY("DALAB Navy", Color(0xFF003152)),
    DALAB_BLUE("DALAB Blue", Color(0xFF0D72C4)),
    ROYAL_BLUE("Royal Blue", Color(0xFF2563EB)),
    VIOLET("Violet", Color(0xFF7C3AED)),
    DEEP_PURPLE("Deep Purple", Color(0xFF673AB7)),
    EMERALD_GREEN("Emerald Green", Color(0xFF047857)),
    CYAN_BLUE("Cyan Blue", Color(0xFF0E7490)),
    ORANGE("Orange", Color(0xFFC2410C)),
    RED("Red", Color(0xFFDC2626)),
    PINK("Pink", Color(0xFFDB2777)),
    AMBER_GOLD("Amber Gold", Color(0xFFB45309)),
    LIME_GREEN("Lime Green", Color(0xFF4D7C0F)),
    INDIGO("Indigo", Color(0xFF4F46E5)),
}
