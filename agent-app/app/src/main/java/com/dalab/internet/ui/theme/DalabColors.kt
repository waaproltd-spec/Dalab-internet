package com.dalab.internet.ui.theme

import androidx.compose.ui.graphics.Color

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
val DalabBlue = Color(0xFF003152)
val DalabSoftBlue = Color(0xFFADDFF1)
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
