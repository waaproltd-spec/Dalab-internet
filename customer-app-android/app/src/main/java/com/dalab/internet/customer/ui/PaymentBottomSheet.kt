package com.dalab.internet.customer.ui

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.OrderStatus
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.RealtimeClient
import com.dalab.internet.customer.util.generateQrCodeBitmap
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal val PaymentGreen = Color(0xFF16A34A)
internal val PaymentGreenDark = Color(0xFF0F7A3D)
private val SheetMuted = Color(0xFF6B7280)

private const val COUNTDOWN_SECONDS = 60

/**
 * Shown right after a new order is created (CheckoutScreen's onOrderCreated
 * success path). This is purely a presentation layer over machinery that
 * already exists end-to-end: the USSD dial string and payment-number
 * resolution are computed exactly as CheckoutScreen already did for its own
 * immediate auto-dial (never re-derived here differently), and payment
 * verification reuses the same SSE (GET /orders/stream) + GET /orders/:id
 * pattern already proven in OrderDetailScreen — no new backend endpoint.
 * Never calls TelephonyManager.sendUssdRequest or any other Agent-App-only
 * dialing mechanism; Dial here is the same customer-initiated ACTION_DIAL
 * used everywhere else in this app.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PaymentBottomSheet(
    initialOrder: CustomerOrder,
    packageName: String,
    amount: Double,
    dialTarget: String?,
    onDismiss: () -> Unit,
    onCompleted: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var order by remember { mutableStateOf(initialOrder) }
    var secondsLeft by remember { mutableStateOf(COUNTDOWN_SECONDS) }
    var expired by remember { mutableStateOf(false) }
    var verifying by remember { mutableStateOf(false) }
    var showSimSheet by remember { mutableStateOf(false) }
    var detectedSims by remember { mutableStateOf<List<DetectedSim>>(emptyList()) }

    val phoneStatePermissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
        // Whether granted or denied, proceed with whatever detectActiveSims now
        // returns (empty list on denial just means "dial directly, no picker").
        maybeShowSimPickerThenDial(context, dialTarget) { sims -> detectedSims = sims; showSimSheet = true }
    }

    fun startDial() {
        if (dialTarget == null) return
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            phoneStatePermissionLauncher.launch(Manifest.permission.READ_PHONE_STATE)
            return
        }
        val sims = detectActiveSims(context)
        if (sims.size == 2) {
            detectedSims = sims
            showSimSheet = true
        } else {
            context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(dialTarget))))
        }
    }

    // Countdown — independent of verification state; reaching 0 disables
    // Confirm Payment and surfaces the expired message, unless already
    // completed by then.
    LaunchedEffect(secondsLeft, expired, order.status) {
        if (order.status == OrderStatus.COMPLETED) return@LaunchedEffect
        if (expired || secondsLeft <= 0) {
            expired = true
            return@LaunchedEffect
        }
        delay(1000)
        secondsLeft -= 1
    }

    // Verification: reuse the exact SSE + poll pattern already proven in
    // OrderDetailScreen — connect once Confirm Payment is tapped, refetch on
    // every event, and react to order.status the moment the existing
    // Agent-App/backend pipeline (SMS match -> verify-payment -> dial ->
    // dial-attempt success -> order completes -> SSE broadcast) flips it.
    fun refreshOrder() {
        scope.launch {
            try {
                ApiClient.service.getOrder(initialOrder.id).body()?.let { order = it }
            } catch (_: Exception) {
                // Next SSE event or poll tick retries — no need to surface this.
            }
        }
    }
    DisposableEffect(verifying) {
        if (!verifying) return@DisposableEffect onDispose {}
        val realtime = RealtimeClient(path = "orders/stream") { refreshOrder() }
        realtime.connect()
        onDispose { realtime.disconnect() }
    }
    LaunchedEffect(verifying) {
        if (!verifying) return@LaunchedEffect
        while (verifying && order.status != OrderStatus.COMPLETED) {
            refreshOrder()
            delay(4000)
        }
    }
    LaunchedEffect(order.status) {
        if (order.status == OrderStatus.COMPLETED) onCompleted()
    }

    val failed = order.status == OrderStatus.FAILED || order.status == OrderStatus.CANCELLED

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Finish Your Payment", fontWeight = FontWeight.Bold, fontSize = 19.sp)
            Spacer(Modifier.height(4.dp))
            Text(packageName, fontSize = 13.sp, color = SheetMuted)
            Spacer(Modifier.height(14.dp))
            Text("$${"%.2f".format(amount)}", fontWeight = FontWeight.Black, fontSize = 32.sp, color = PaymentGreen)

            Spacer(Modifier.height(16.dp))
            CountdownBadge(secondsLeft = secondsLeft, expired = expired)

            if (dialTarget != null) {
                Spacer(Modifier.height(18.dp))
                val qrBitmap = remember(dialTarget) { generateQrCodeBitmap(dialTarget) }
                if (qrBitmap != null) {
                    Image(
                        bitmap = qrBitmap,
                        contentDescription = "Payment QR code",
                        modifier = Modifier
                            .size(160.dp)
                            .clip(RoundedCornerShape(16.dp))
                            .background(Color.White)
                            .padding(8.dp),
                    )
                }

                Spacer(Modifier.height(16.dp))
                Surface(
                    shape = RoundedCornerShape(14.dp),
                    color = PaymentGreen.copy(alpha = 0.08f),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(dialTarget, modifier = Modifier.weight(1f), fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                        IconButton(onClick = {
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.setPrimaryClip(ClipData.newPlainText("USSD code", dialTarget))
                        }) {
                            Icon(Icons.Filled.ContentCopy, contentDescription = "Copy", tint = PaymentGreen)
                        }
                        IconButton(onClick = { startDial() }) {
                            Icon(Icons.Filled.Call, contentDescription = "Dial", tint = PaymentGreen)
                        }
                    }
                }
            }

            Spacer(Modifier.height(20.dp))

            when {
                order.status == OrderStatus.COMPLETED -> {
                    Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = PaymentGreen, modifier = Modifier.size(40.dp))
                    Spacer(Modifier.height(8.dp))
                    Text("Payment completed!", fontWeight = FontWeight.Bold, color = PaymentGreen, fontSize = 16.sp)
                }
                failed -> {
                    Icon(Icons.Filled.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(36.dp))
                    Spacer(Modifier.height(6.dp))
                    Text("This payment didn't go through.", color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
                    Spacer(Modifier.height(12.dp))
                    RegenerateButton {
                        secondsLeft = COUNTDOWN_SECONDS
                        expired = false
                        verifying = false
                    }
                }
                expired -> {
                    Text(
                        "Payment expired. Please generate a new payment request.",
                        color = MaterialTheme.colorScheme.error,
                        fontSize = 13.sp,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                    Spacer(Modifier.height(12.dp))
                    RegenerateButton {
                        secondsLeft = COUNTDOWN_SECONDS
                        expired = false
                        verifying = false
                    }
                }
                verifying -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(color = PaymentGreen, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(10.dp))
                        Text("Verifying payment...", fontSize = 14.sp, fontWeight = FontWeight.Medium)
                    }
                }
                else -> {
                    Button(
                        onClick = { verifying = true },
                        enabled = !expired,
                        colors = ButtonDefaults.buttonColors(containerColor = PaymentGreen),
                        shape = RoundedCornerShape(28.dp),
                        modifier = Modifier.fillMaxWidth().height(54.dp),
                    ) {
                        Text("Confirm Payment", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
        }
    }

    if (showSimSheet) {
        SimSelectionSheet(
            sims = detectedSims,
            onDismiss = { showSimSheet = false },
            onSimSelected = {
                showSimSheet = false
                if (dialTarget != null) {
                    context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(dialTarget))))
                }
            },
        )
    }
}

private fun maybeShowSimPickerThenDial(context: Context, dialTarget: String?, onDetected: (List<DetectedSim>) -> Unit) {
    val sims = detectActiveSims(context)
    if (sims.size == 2) {
        onDetected(sims)
    } else if (dialTarget != null) {
        context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(dialTarget))))
    }
}

@Composable
private fun RegenerateButton(onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = PaymentGreen),
        shape = RoundedCornerShape(24.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text("Generate New Payment Request", fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun CountdownBadge(secondsLeft: Int, expired: Boolean) {
    val minutes = secondsLeft / 60
    val secs = secondsLeft % 60
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = if (expired) MaterialTheme.colorScheme.error.copy(alpha = 0.12f) else PaymentGreen.copy(alpha = 0.12f),
    ) {
        Text(
            if (expired) "Expired" else String.format("%d:%02d", minutes, secs),
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            fontWeight = FontWeight.Bold,
            fontSize = 14.sp,
            color = if (expired) MaterialTheme.colorScheme.error else PaymentGreenDark,
        )
    }
}
