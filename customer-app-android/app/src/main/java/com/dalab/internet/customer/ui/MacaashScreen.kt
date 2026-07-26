package com.dalab.internet.customer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.customer.data.MacaashHistoryEntry
import com.dalab.internet.customer.data.MacaashReward
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.RedeemRequest
import com.dalab.internet.customer.util.formatApiDateTime
import kotlinx.coroutines.launch

/** Macaash rewards: live balance, a redeemable catalog, and points history. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MacaashScreen() {
    var balance by remember { mutableStateOf<Int?>(null) }
    var rewards by remember { mutableStateOf<List<MacaashReward>>(emptyList()) }
    var history by remember { mutableStateOf<List<MacaashHistoryEntry>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var message by remember { mutableStateOf<String?>(null) }
    var redeemingId by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun refresh() {
        scope.launch {
            try {
                balance = ApiClient.service.getMacaashBalance().body()?.balance
                rewards = ApiClient.service.getMacaashRewards().body().orEmpty()
                history = ApiClient.service.getMacaashHistory().body().orEmpty()
            } catch (_: Exception) {
                // Leave whatever loaded successfully; the screen degrades gracefully.
            }
            loading = false
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Scaffold(topBar = { TopAppBar(title = { Text("Macaash Rewards") }) }) { padding ->
        if (loading) {
            Box(modifier = Modifier.padding(padding).fillMaxSize()) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            }
        } else {
            LazyColumn(modifier = Modifier.padding(padding).fillMaxSize()) {
                item {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp)
                            .clip(RoundedCornerShape(20.dp))
                            .background(
                                Brush.linearGradient(listOf(Color(0xFF16A34A), Color(0xFF0E7A38)))
                            )
                            .padding(24.dp),
                    ) {
                        Column {
                            Text("Macaash Points", color = Color.White, style = MaterialTheme.typography.labelLarge)
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "${balance ?: 0}",
                                color = Color.White,
                                style = MaterialTheme.typography.headlineLarge,
                                fontWeight = FontWeight.Bold,
                            )
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "Earn points on every completed order — redeem them below.",
                                color = Color.White,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }

                if (message != null) {
                    item {
                        Text(
                            message!!,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }

                item {
                    Text(
                        "Redeem",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                items(rewards, key = { it.id }) { reward ->
                    RewardRow(
                        reward = reward,
                        affordable = (balance ?: 0) >= reward.cost,
                        redeeming = redeemingId == reward.id,
                        onRedeem = {
                            redeemingId = reward.id
                            message = null
                            scope.launch {
                                try {
                                    val response = ApiClient.service.redeemMacaash(RedeemRequest(reward.id))
                                    val body = response.body()
                                    if (response.isSuccessful && body != null) {
                                        balance = body.remainingBalance
                                        message = "Redeemed: ${body.redeemed}"
                                        history = ApiClient.service.getMacaashHistory().body().orEmpty()
                                    } else {
                                        message = "Couldn't redeem that reward right now."
                                    }
                                } catch (_: Exception) {
                                    message = "Network error while redeeming."
                                }
                                redeemingId = null
                            }
                        },
                    )
                }

                item {
                    Text(
                        "History",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                if (history.isEmpty()) {
                    item {
                        Text(
                            "No Macaash activity yet.",
                            modifier = Modifier.padding(horizontal = 16.dp),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                } else {
                    items(history, key = { it.id }) { entry ->
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Column {
                                Text(entry.reason ?: "Macaash activity")
                                Text(formatApiDateTime(entry.createdAt), style = MaterialTheme.typography.labelSmall)
                            }
                            Text(
                                if (entry.points >= 0) "+${entry.points}" else "${entry.points}",
                                fontWeight = FontWeight.Bold,
                                color = if (entry.points >= 0) Color(0xFF16A34A) else MaterialTheme.colorScheme.error,
                            )
                        }
                        Divider()
                    }
                }

                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }
}

@Composable
private fun RewardRow(reward: MacaashReward, affordable: Boolean, redeeming: Boolean, onRedeem: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(reward.title, fontWeight = FontWeight.Bold)
                Text("${reward.cost} points", style = MaterialTheme.typography.bodySmall)
            }
            Button(onClick = onRedeem, enabled = affordable && !redeeming) {
                Text(if (redeeming) "..." else "Redeem")
            }
        }
    }
}
