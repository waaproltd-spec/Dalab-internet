package com.dalab.internet.customer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.network.ApiClient
import java.util.Calendar

private fun greeting(): String {
    val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
    return when {
        hour < 12 -> "Good Morning"
        hour < 18 -> "Good Afternoon"
        else -> "Good Evening"
    }
}

/** Home: greeting, Macaash promo, and the provider grid — tap a provider to see its packages. */
@Composable
fun HomeScreen(onOpenCompany: (Company) -> Unit, onOpenMacaash: () -> Unit, otpCode: String? = null) {
    var companies by remember { mutableStateOf<List<Company>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var showSupport by remember { mutableStateOf(false) }
    val customer = SessionManager.currentCustomer()

    LaunchedEffect(Unit) {
        try {
            companies = ApiClient.service.getCompanies().body().orEmpty()
        } catch (_: Exception) {
            // Leave the list empty; the grid shows "no providers" below.
        }
        loading = false
    }

    Box(modifier = Modifier.fillMaxSize()) {
        LazyVerticalGrid(
            columns = GridCells.Fixed(2),
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item(span = { GridItemSpan(2) }) {
                Column {
                    if (otpCode != null) {
                        OtpCodeCard(otpCode)
                        Spacer(Modifier.height(16.dp))
                    }
                    Text(greeting(), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        customer?.name?.takeIf { it.isNotBlank() } ?: customer?.phone ?: "there",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(16.dp))
                    MacaashBanner(onClick = onOpenMacaash)
                    Spacer(Modifier.height(20.dp))
                    if (loading) {
                        CircularProgressIndicator(modifier = Modifier.padding(vertical = 16.dp))
                    } else if (companies.isEmpty()) {
                        Text("No providers available.", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }

            items(companies, key = { it.id }) { company ->
                CompanyCard(company = company, onClick = { onOpenCompany(company) })
            }

            item(span = { GridItemSpan(2) }) { Spacer(Modifier.height(72.dp)) }
        }

        FloatingActionButton(
            onClick = { showSupport = true },
            modifier = Modifier.align(Alignment.BottomEnd).padding(20.dp),
        ) {
            Icon(Icons.Filled.SupportAgent, contentDescription = "Support")
        }
    }

    if (showSupport) {
        AlertDialog(
            onDismissRequest = { showSupport = false },
            title = { Text("Need help?") },
            text = { Text("Contact DALAB Internet support at +252 61 000 0000 or support@dalabinternet.so") },
            confirmButton = { TextButton(onClick = { showSupport = false }) { Text("OK") } },
        )
    }
}

/**
 * No SMS gateway is connected — POST /auth/otp/request returns the code
 * directly so the app can show it to the customer, same as the card already
 * on the OTP entry screen (carried over so it's also visible here on Home).
 */
@Composable
private fun OtpCodeCard(code: String) {
    Surface(
        color = Color(0xFFEFF3FF),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Verification Code", fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, color = Color(0xFF1D2E8C))
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                code.forEach { digit ->
                    Box(
                        modifier = Modifier
                            .size(42.dp)
                            .background(Color.White, RoundedCornerShape(10.dp)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(digit.toString(), fontSize = 19.sp, fontWeight = FontWeight.Bold, color = Color(0xFF1D2E8C))
                    }
                }
            }
        }
    }
}

@Composable
private fun MacaashBanner(onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(Brush.linearGradient(listOf(Color(0xFF16A34A), Color(0xFF0E7A38))))
            .clickable(onClick = onClick)
            .padding(24.dp),
    ) {
        Column {
            Text("Macaash Rewards", color = Color.White, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(6.dp))
            Text("Buy packages and earn points", color = Color.White, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun CompanyCard(company: Company, onClick: () -> Unit) {
    val offline = company.status == "offline"
    val brandColor = remember(company.colorHex) {
        try {
            Color(android.graphics.Color.parseColor(company.colorHex))
        } catch (_: Exception) {
            Color(0xFF1D2E8C)
        }
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !offline, onClick = onClick),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(vertical = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                modifier = Modifier
                    .size(56.dp)
                    .clip(CircleShape)
                    .background(if (offline) Color.LightGray else brandColor),
                contentAlignment = Alignment.Center,
            ) {
                if (offline) {
                    Icon(Icons.Filled.WifiOff, contentDescription = "Offline", tint = Color.DarkGray)
                } else {
                    Text(
                        company.name.take(1).uppercase(),
                        color = Color.White,
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
            Text(company.name, fontWeight = FontWeight.Bold)
            if (offline) {
                Text("Offline", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
            }
        }
    }
}
