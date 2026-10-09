package com.dalab.internet.ui.i18n

import androidx.compose.material3.LocalTextStyle
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import com.dalab.internet.ui.theme.AgentLanguage
import com.dalab.internet.ui.theme.AgentSettings

/**
 * [english] in the agent's chosen language (More → Appearance & Language).
 *
 * The app is written in English; Somali comes from [SomaliStrings] -- exact
 * phrases first, then [SomaliPatterns] for phrases with a number or name in
 * them ("12 sales created"). Anything not in the dictionary (customer names,
 * package names, server messages) is shown unchanged. An ALL-CAPS phrase is
 * looked up as written and returned in capitals.
 */
fun tr(english: String): String {
    if (AgentSettings.language != AgentLanguage.SOMALI || english.isBlank()) return english
    SomaliStrings[english]?.let { return it }
    val trimmed = english.trim()
    if (trimmed != english) SomaliStrings[trimmed]?.let { return english.replace(trimmed, it) }
    val isCaps = english.any { it.isLetter() } && english == english.uppercase()
    if (isCaps) {
        SomaliStringsLower[english.lowercase()]?.let { return it.uppercase() }
    }
    for ((pattern, replacement) in SomaliPatterns) {
        val m = pattern.matchEntire(english) ?: continue
        return m.groupValues.drop(1).foldIndexed(replacement) { i, acc, v -> acc.replace("{${i + 1}}", tr(v)) }
    }
    return english
}

private val SomaliStringsLower: Map<String, String> by lazy { SomaliStrings.mapKeys { it.key.lowercase() } }

/**
 * Drop-in for Material3's Text(String): every screen imports this one, so
 * all on-screen text follows the agent's language with no per-screen code.
 * Reads [AgentSettings.language], so switching language redraws at once.
 */
@Composable
fun Text(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = Color.Unspecified,
    fontSize: TextUnit = TextUnit.Unspecified,
    fontStyle: FontStyle? = null,
    fontWeight: FontWeight? = null,
    fontFamily: FontFamily? = null,
    letterSpacing: TextUnit = TextUnit.Unspecified,
    textDecoration: TextDecoration? = null,
    textAlign: TextAlign? = null,
    lineHeight: TextUnit = TextUnit.Unspecified,
    overflow: TextOverflow = TextOverflow.Clip,
    softWrap: Boolean = true,
    maxLines: Int = Int.MAX_VALUE,
    minLines: Int = 1,
    onTextLayout: ((TextLayoutResult) -> Unit)? = null,
    style: TextStyle = LocalTextStyle.current,
) {
    // Reading the setting here subscribes this Text to language changes.
    @Suppress("UNUSED_VARIABLE") val language = AgentSettings.language
    androidx.compose.material3.Text(
        text = tr(text),
        modifier = modifier,
        color = color,
        fontSize = fontSize,
        fontStyle = fontStyle,
        fontWeight = fontWeight,
        fontFamily = fontFamily,
        letterSpacing = letterSpacing,
        textDecoration = textDecoration,
        textAlign = textAlign,
        lineHeight = lineHeight,
        overflow = overflow,
        softWrap = softWrap,
        maxLines = maxLines,
        minLines = minLines,
        onTextLayout = onTextLayout ?: {},
        style = style,
    )
}
