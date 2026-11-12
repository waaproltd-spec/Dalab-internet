package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import com.dalab.internet.ui.i18n.tr
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Image
import androidx.compose.ui.res.painterResource
import com.dalab.internet.R
import com.dalab.internet.auth.HubLogin
import com.dalab.internet.auth.HubLoginResult
import com.dalab.internet.auth.SignedInSystem
import kotlinx.coroutines.launch

/**
 * The one sign-in screen of the AGENT APP for every system: phone number +
 * PIN, no system picker. The Admin Hub finds the agent's system; nothing on
 * this screen ever names a system before the sign-in succeeds.
 */
@Composable
fun AgentLoginScreen(onSignedIn: (SignedInSystem) -> Unit) {
    var phone by rememberSaveable { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var showPin by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current

    val phoneDigits = phone.filter { it.isDigit() }
    val canSubmit = !busy && phoneDigits.length >= 9 && pin.isNotEmpty()

    fun submit() {
        if (!canSubmit) return
        focus.clearFocus()
        busy = true
        error = null
        scope.launch {
            when (val result = HubLogin.signIn(phoneDigits, pin)) {
                is HubLoginResult.Success -> {
                    pin = ""
                    onSignedIn(result.system)
                }
                is HubLoginResult.Failure -> error = result.message
            }
            busy = false
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 28.dp, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        // The official WAAPRO LTD logo, unchanged (res/drawable/waapro_ltd_logo.png).
        Image(
            painter = painterResource(R.drawable.waapro_ltd_logo),
            contentDescription = "WAAPRO LTD",
            modifier = Modifier.size(112.dp),
        )
        Text("WAAPRO LTD", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.sp)
        Spacer(Modifier.height(14.dp))
        Text("Agent App", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text(
            "Sign in with your phone number and PIN.",
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(28.dp))

        OutlinedTextField(
            value = phone,
            onValueChange = { v -> phone = v.filter { it.isDigit() || it == '+' || it == ' ' }.take(16) },
            label = { Text("Phone number") },
            placeholder = { Text("61xxxxxxx") },
            singleLine = true,
            enabled = !busy,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = pin,
            onValueChange = { v -> pin = v.take(64) },
            label = { Text("PIN") },
            singleLine = true,
            enabled = !busy,
            visualTransformation = if (showPin) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            trailingIcon = {
                IconButton(onClick = { showPin = !showPin }) {
                    Icon(
                        if (showPin) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                        contentDescription = tr(if (showPin) "Hide PIN" else "Show PIN"),
                    )
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )

        if (error != null) {
            Spacer(Modifier.height(14.dp))
            Text(error!!, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
        }

        Spacer(Modifier.height(22.dp))
        Button(
            onClick = { submit() },
            enabled = canSubmit,
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            if (busy) {
                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(22.dp), color = MaterialTheme.colorScheme.onPrimary)
                Spacer(Modifier.width(10.dp))
                Text("Signing in...")
            } else {
                Text("Sign in")
            }
        }
        Spacer(Modifier.height(18.dp))
        Text(
            "Forgot your PIN? Ask your admin.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}
