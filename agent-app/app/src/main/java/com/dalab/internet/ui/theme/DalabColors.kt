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
// The brand color and its pale tint follow the agent's Theme color (More →
// Appearance & Language). They're getters over Compose state, so every
// screen that reads them redraws the moment the color changes. DALAB Navy,
// the default, is exactly the original #003152 / #ADDFF1.
val DalabBlue: Color get() = AgentSettings.accent.color
val DalabSoftBlue: Color get() = AgentSettings.accent.let { if (it == AgentAccent.DALAB_NAVY) DalabNavySoft else lerp(it.color, Color.White, 0.65f) }
private val DalabNavySoft = Color(0xFFADDFF1)
val DalabWhite = Color(0xFFFFFFFF)

// A pale, blue-tinted neutral for card/surface differentiation against a
// pure-white background, and a matching mid-tone for borders/dividers --
// both derived from DalabSoftBlue rather than introducing a new hue.
val DalabSurfaceTint = Color(0xFFF3F8FB)
val DalabOutline = Color(0xFFB9CBD6)

// Functional status colors -- see this file's header comment for why these
// are excluded from the brand palette proper. Matches the exact hex values
// already used for the same purpose elsewhere in this app (OrderCard's
// status pills, balance low-threshold warnings, etc.).
val DalabSuccessGreen = Color(0xFF16A34A)
val DalabWarningAmber = Color(0xFFF2C200)
val DalabDangerRed = Color(0xFFC81E2C)
val DalabDangerRedContainer = Color(0xFFFEE2E2)
val DalabInfoBlue = Color(0xFF1D4ED8)

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
