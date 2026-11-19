package com.dalab.internet.ui

import android.app.Activity
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.ui.i18n.Text
import com.dalab.internet.ussd.InteractiveUssdScreenLock

/**
 * While an on-screen USSD session runs (a menu package, Reseller Withdraw,
 * Money Exchange or a wallet lookup -- everything that holds
 * [InteractiveUssdScreenLock]), the Agent App stays out of the way of the
 * carrier's dialog: its keyboard is closed, its screens are covered (no
 * typing into a form, nothing to tap), Back does nothing and the screen
 * stays on. The cover lifts by itself when the session ends.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun TransactionInProgressGuard() {
    val active by InteractiveUssdScreenLock.active.collectAsState()
    val activity = LocalContext.current as? Activity
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current

    DisposableEffect(active) {
        if (active) {
            activity?.window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            keyboard?.hide()
            focus.clearFocus(force = true)
        }
        onDispose {
            if (active) activity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }
    // Registered after the app's own Back handlers, so it wins while active.
    BackHandler(enabled = active) {}
    if (!active) return

    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xE60B1240))
            // Every touch stops here: nothing underneath can be tapped.
            .pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) awaitPointerEvent().changes.forEach { it.consume() }
                }
            },
    ) {
        Surface(shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.surface, modifier = Modifier.padding(28.dp)) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.padding(24.dp),
            ) {
                CircularProgressIndicator(color = WaaproNavy, modifier = Modifier.size(44.dp))
                Text("Transaction in progress", fontWeight = FontWeight.ExtraBold, fontSize = 19.sp, textAlign = TextAlign.Center)
                Text(
                    "The carrier screen is being filled in automatically. Don't touch the phone until it finishes.",
                    color = WaaproMuted, fontSize = 14.sp, textAlign = TextAlign.Center,
                )
            }
        }
    }
}
