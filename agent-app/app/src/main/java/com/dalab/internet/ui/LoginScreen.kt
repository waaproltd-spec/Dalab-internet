package com.dalab.internet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.auth.AuthRepository
import com.dalab.internet.auth.LoginResult
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(onLoggedIn: () -> Unit) {
    var phone by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun submit() {
        error = null
        loading = true
        scope.launch {
            when (val result = AuthRepository.login(phone.trim())) {
                is LoginResult.Success -> onLoggedIn()
                is LoginResult.Failure -> error = result.message
            }
            loading = false
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("DALAB Agent", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text("Sign in with your agent phone number", style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(28.dp))

        OutlinedTextField(
            value = phone,
            onValueChange = { phone = it },
            label = { Text("Phone number") },
            singleLine = true,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                keyboardType = androidx.compose.ui.text.input.KeyboardType.Phone,
                imeAction = androidx.compose.ui.text.input.ImeAction.Done,
            ),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(
                onDone = { if (phone.isNotBlank() && !loading) submit() },
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(20.dp))

        if (error != null) {
            Text(error!!, color = MaterialTheme.colorScheme.error)
            Spacer(Modifier.height(12.dp))
        }

        Button(
            onClick = { submit() },
            enabled = phone.isNotBlank() && !loading,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (loading) "Signing in..." else "Sign in")
        }

        Spacer(Modifier.height(12.dp))
        Text(
            "Agent accounts are created by the Super Admin — contact your admin " +
                "if your phone number isn't registered yet.",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
