package com.sahal.data.customer.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sahal.data.customer.prefs.AppLanguage
import com.sahal.data.customer.prefs.LocalizationManager
import com.sahal.data.customer.prefs.ThemeManager
import com.sahal.data.customer.prefs.ThemeMode

private val HeaderStart = Color(0xFF1D2E8C)
private val HeaderEnd = Color(0xFF16A34A)

/**
 * Theme (Light/Dark) and language (English/Somali) preferences, persisted
 * via [ThemeManager]/[LocalizationManager] so they survive an app restart.
 * Both take effect immediately app-wide since they're backed by real
 * Compose state, not just written to disk.
 */
@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val compact = LocalConfiguration.current.screenHeightDp < 700
    val isDark = ThemeManager.isDark
    val language = LocalizationManager.language

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        Brush.linearGradient(listOf(HeaderStart, HeaderEnd)),
                        shape = RoundedCornerShape(bottomStart = 24.dp, bottomEnd = 24.dp),
                    )
                    .padding(horizontal = 12.dp, vertical = if (compact) 14.dp else 20.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
                    }
                    Text(
                        LocalizationManager.tr("Settings", "Dejinta"),
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        fontSize = 19.sp,
                    )
                }
            }
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(16.dp)
                .fillMaxSize(),
        ) {
            SettingsSectionTitle(LocalizationManager.tr("Appearance", "Muuqaalka"))
            Spacer(Modifier.height(10.dp))
            Surface(
                shape = RoundedCornerShape(18.dp),
                color = MaterialTheme.colorScheme.surface,
                modifier = Modifier.fillMaxWidth().shadow(2.dp, RoundedCornerShape(18.dp)),
            ) {
                Column(modifier = Modifier.padding(4.dp)) {
                    ThemeOptionRow(
                        icon = Icons.Filled.LightMode,
                        label = LocalizationManager.tr("Light Mode", "Iftiin"),
                        selected = !isDark,
                        onClick = { ThemeManager.setMode(ThemeMode.LIGHT) },
                    )
                    ThemeOptionRow(
                        icon = Icons.Filled.DarkMode,
                        label = LocalizationManager.tr("Dark Mode", "Mugdi"),
                        selected = isDark,
                        onClick = { ThemeManager.setMode(ThemeMode.DARK) },
                    )
                }
            }

            Spacer(Modifier.height(28.dp))
            SettingsSectionTitle(LocalizationManager.tr("Language", "Luqadda"))
            Spacer(Modifier.height(10.dp))
            Surface(
                shape = RoundedCornerShape(18.dp),
                color = MaterialTheme.colorScheme.surface,
                modifier = Modifier.fillMaxWidth().shadow(2.dp, RoundedCornerShape(18.dp)),
            ) {
                Column(modifier = Modifier.padding(4.dp)) {
                    AppLanguage.entries.forEach { option ->
                        LanguageOptionRow(
                            label = option.displayName,
                            selected = language == option,
                            onClick = { LocalizationManager.setLanguage(option) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsSectionTitle(text: String) {
    Text(
        text,
        fontWeight = FontWeight.Bold,
        fontSize = 13.sp,
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
        modifier = Modifier.padding(start = 4.dp),
    )
}

@Composable
private fun ThemeOptionRow(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, selected: Boolean, onClick: () -> Unit) {
    val rowColor by animateColorAsState(
        targetValue = if (selected) HeaderStart.copy(alpha = 0.10f) else Color.Transparent,
        animationSpec = tween(250),
        label = "themeRowColor",
    )
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(rowColor)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = HeaderStart, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(14.dp))
        Text(label, modifier = Modifier.weight(1f), fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface)
        if (selected) {
            Icon(Icons.Filled.Check, contentDescription = null, tint = HeaderEnd, modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
private fun LanguageOptionRow(label: String, selected: Boolean, onClick: () -> Unit) {
    val rowColor by animateColorAsState(
        targetValue = if (selected) HeaderStart.copy(alpha = 0.10f) else Color.Transparent,
        animationSpec = tween(250),
        label = "languageRowColor",
    )
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(rowColor)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Language, contentDescription = null, tint = HeaderStart, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(14.dp))
        Text(label, modifier = Modifier.weight(1f), fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface)
        if (selected) {
            Icon(Icons.Filled.Check, contentDescription = null, tint = HeaderEnd, modifier = Modifier.size(20.dp))
        }
    }
}
