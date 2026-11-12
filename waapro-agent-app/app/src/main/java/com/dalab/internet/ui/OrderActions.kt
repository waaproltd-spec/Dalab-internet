package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import com.dalab.internet.ui.i18n.tr
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.data.Order
import com.dalab.internet.data.OrderStatus
import com.dalab.internet.network.AgentActionRequest
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.launch
import retrofit2.Response

/** The agent's order actions (server: /agent/orders/:id/...). */
enum class AgentOrderAction(
    val label: String,
    val confirmTitle: String,
    val explanation: String,
    val reasonLabel: String?,
    val reasonRequired: Boolean,
    val color: Color,
    val icon: ImageVector,
) {
    APPROVE(
        "Approve payment", "Approve this payment?",
        "The order moves to processing and its data is sent from the SIM it is routed to.",
        "Reason / transaction ID (required if no payment SMS was matched)", false,
        Color(0xFF16A34A), Icons.Filled.CheckCircle,
    ),
    REJECT(
        "Reject payment", "Reject this payment?",
        "The order fails and nothing is sent. The customer is told the payment didn't go through.",
        "Reason", true,
        Color(0xFFD6203A), Icons.Filled.Block,
    ),
    RETRY(
        "Retry", "Retry this order?",
        "The order goes back to processing and is dialed again. Only for an order whose payment was verified.",
        null, false,
        Color(0xFF1565D8), Icons.Filled.Refresh,
    ),
    CANCEL(
        "Cancel order", "Cancel this order?",
        "The order is cancelled and nothing is sent. The customer is told.",
        "Reason", true,
        Color(0xFF6B7280), Icons.Filled.Cancel,
    ),
    REVERSE(
        "Reverse order", "Reverse this completed order?",
        "The order is cancelled and its points, commission and referral bonus are taken back. The data already sent is not recovered.",
        "Reason", true,
        Color(0xFFB45309), Icons.AutoMirrored.Filled.Undo,
    ),
}

/** Which actions fit an order's status (the server checks again). */
fun actionsFor(status: OrderStatus): List<AgentOrderAction> = when (status) {
    OrderStatus.PENDING -> listOf(AgentOrderAction.APPROVE, AgentOrderAction.REJECT, AgentOrderAction.CANCEL)
    OrderStatus.IN_PROGRESS -> listOf(AgentOrderAction.RETRY, AgentOrderAction.REJECT, AgentOrderAction.CANCEL)
    OrderStatus.FAILED -> listOf(AgentOrderAction.RETRY, AgentOrderAction.CANCEL)
    OrderStatus.COMPLETED -> listOf(AgentOrderAction.REVERSE)
    OrderStatus.CANCELLED -> emptyList()
}

/**
 * The action buttons on an order, each behind a confirmation (with a reason
 * where needed). One request at a time; the server's answer -- including
 * "someone already handled it", "the data was already sent" and "your
 * operational access is off" -- is shown as it is.
 */
@Composable
fun AgentOrderActions(order: Order, onUpdated: (Order, String) -> Unit) {
    val actions = actionsFor(order.status)
    if (actions.isEmpty()) return
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<AgentOrderAction?>(null) }
    var reason by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(WaaproSoft.copy(alpha = 0.5f)).padding(12.dp),
    ) {
        Text("ORDER ACTIONS", color = WaaproNavy, fontWeight = FontWeight.Bold, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        actions.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                row.forEach { action ->
                    Button(
                        onClick = { pending = action; reason = ""; error = null },
                        enabled = !busy,
                        colors = ButtonDefaults.buttonColors(containerColor = action.color),
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 10.dp),
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    ) {
                        Icon(action.icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(action.label, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp, maxLines = 1)
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
            Spacer(Modifier.height(8.dp))
        }
    }

    val action = pending ?: return
    AlertDialog(
        onDismissRequest = { if (!busy) pending = null },
        title = { Text(action.confirmTitle, fontWeight = FontWeight.Bold) },
        text = {
            Column {
                Text("Order ${order.id} · $${"%.2f".format(order.amount)} · ${order.companyName}", fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(8.dp))
                Text(action.explanation)
                if (action.reasonLabel != null) {
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = reason,
                        onValueChange = { reason = it.take(300) },
                        label = { Text(action.reasonLabel) },
                        enabled = !busy,
                        singleLine = false,
                        maxLines = 3,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (error != null) {
                    Spacer(Modifier.height(10.dp))
                    androidx.compose.material3.Text(error!!, color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (busy) return@Button
                    if (action.reasonRequired && reason.trim().length < 3) {
                        error = tr("Enter a reason.")
                        return@Button
                    }
                    busy = true
                    error = null
                    scope.launch {
                        val body = AgentActionRequest(reason.trim().ifEmpty { null })
                        val result = try {
                            val response: Response<Order> = when (action) {
                                AgentOrderAction.APPROVE -> ApiClient.service.approvePayment(order.id, body)
                                AgentOrderAction.REJECT -> ApiClient.service.rejectPayment(order.id, body)
                                AgentOrderAction.RETRY -> ApiClient.service.retryOrder(order.id, body)
                                AgentOrderAction.CANCEL -> ApiClient.service.cancelOrder(order.id, body)
                                AgentOrderAction.REVERSE -> ApiClient.service.reverseOrder(order.id, body)
                            }
                            val updated = response.body()
                            if (response.isSuccessful && updated != null) Result.success(updated)
                            else Result.failure(Exception(serverMessage(response) ?: "Couldn't do that (HTTP ${response.code()})."))
                        } catch (e: Exception) {
                            Result.failure(Exception(tr("Couldn't reach the server. Check your connection.")))
                        }
                        busy = false
                        result.onSuccess {
                            pending = null
                            onUpdated(it, doneMessage(action))
                        }.onFailure { error = it.message }
                    }
                },
                enabled = !busy,
                colors = ButtonDefaults.buttonColors(containerColor = action.color),
            ) {
                if (busy) {
                    CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                } else {
                    Text(action.label, color = Color.White)
                }
            }
        },
        dismissButton = { TextButton(onClick = { pending = null }, enabled = !busy) { Text("Back") } },
    )
}

private fun doneMessage(action: AgentOrderAction): String = tr(
    when (action) {
        AgentOrderAction.APPROVE -> "Payment approved. The order is processing and will be dialed."
        AgentOrderAction.REJECT -> "Payment rejected. The order failed."
        AgentOrderAction.RETRY -> "Order sent back to processing. It will be dialed again."
        AgentOrderAction.CANCEL -> "Order cancelled."
        AgentOrderAction.REVERSE -> "Order reversed."
    }
)

/** The server's own error text ({"error": "..."}), if any. */
private fun serverMessage(response: Response<*>): String? = try {
    response.errorBody()?.string()?.let { org.json.JSONObject(it).optString("error").takeIf { s -> s.isNotBlank() } }
} catch (_: Exception) {
    null
}
