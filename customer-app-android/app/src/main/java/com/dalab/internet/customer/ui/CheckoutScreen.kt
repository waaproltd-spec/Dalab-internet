package com.dalab.internet.customer.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.data.PaymentWallet
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.CreateOrderRequest
import com.dalab.internet.customer.prefs.LocalizationManager
import com.dalab.internet.customer.queue.OrderCreateAction
import com.dalab.internet.customer.queue.PendingActionQueue
import com.dalab.internet.customer.queue.RetryClassifier
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.UUID

private val DalabGreen = Color(0xFF16A34A)
private val ScreenBg = Color(0xFF0B0F1E)
private val PanelBg = Color(0xFF141A2E)
private val PanelBorder = Color(0xFF232B45)
private val MutedText = Color(0xFF9CA3B8)

/**
 * Step 3 of checkout — "Confirm Order". The payment method (wallet) is
 * already chosen on the previous screen (PaymentMethodScreen), so this
 * screen shows only the package being purchased and the sender/receiver
 * phone fields — no payment number, no wallet picker. On Pay Now, the
 * dial string is built from the selected wallet's OWN provider's payment
 * number + dial prefix (never the purchased package's company), re-fetched
 * fresh from the backend rather than reused from whatever was loaded when
 * these screens first opened, so a Super Admin change takes effect even
 * mid-checkout.
 */
@Composable
fun CheckoutScreen(company: Company, pkg: PackageItem, wallet: PaymentWallet, onBack: () -> Unit, onOrderCreated: (CustomerOrder) -> Unit) {
    val context = LocalContext.current
    // Always start empty — never default to the logged-in account's phone or
    // any payment number. The customer must type the real sending/receiving
    // number for this specific order every time; auto-filling from session
    // data risks silently reusing the wrong number (e.g. a payment number)
    // for a field that must be a phone number.
    var senderPhone by remember { mutableStateOf("") }
    var receiverPhone by remember { mutableStateOf("") }
    var attemptedSubmit by remember { mutableStateOf(false) }

    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var queued by remember { mutableStateOf(false) }
    val clientRequestId = remember { UUID.randomUUID().toString() }
    val scope = rememberCoroutineScope()

    // Schedule Recharge: payment still happens immediately either way (the
    // dial + createOrder call below is unchanged) — this only lets the
    // customer defer WHEN the provider-side USSD/data delivery happens.
    // scheduledDate/scheduledTime are only meaningful while scheduleEnabled
    // is on; the backend re-validates the same 5-minute-to-30-day bounds
    // regardless of this client-side check.
    var scheduleEnabled by remember { mutableStateOf(false) }
    var scheduledDate by remember { mutableStateOf<LocalDate?>(null) }
    var scheduledTime by remember { mutableStateOf<LocalTime?>(null) }
    var showDatePicker by remember { mutableStateOf(false) }
    var showTimePicker by remember { mutableStateOf(false) }
    val scheduledInstant = remember(scheduledDate, scheduledTime) {
        val date = scheduledDate
        val time = scheduledTime
        if (date != null && time != null) LocalDateTime.of(date, time).atZone(ZoneId.systemDefault()).toInstant() else null
    }
    val scheduleTooSoon = scheduleEnabled && scheduledInstant != null &&
        scheduledInstant.isBefore(Instant.now().plusSeconds(5 * 60))
    val scheduleMissing = scheduleEnabled && scheduledInstant == null

    val compact = LocalConfiguration.current.screenHeightDp < 700
    val outerPadding = if (compact) 14.dp else 20.dp
    val gap = if (compact) 12.dp else 18.dp
    val buttonHeight = if (compact) 48.dp else 56.dp

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(ScreenBg)
            .padding(horizontal = outerPadding, vertical = outerPadding.times(0.6f)),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
            }
            Text("Confirm Order", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        }

        Spacer(Modifier.height(gap))
        Surface(
            color = PanelBg,
            shape = RoundedCornerShape(20.dp),
            border = BorderStroke(1.dp, PanelBorder),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 18.dp, vertical = if (compact) 14.dp else 18.dp),
            ) {
                Text(pkg.name, color = Color.White, fontWeight = FontWeight.Bold, fontSize = if (compact) 18.sp else 20.sp)
                Spacer(Modifier.height(4.dp))
                Text(
                    buildList {
                        add(company.name)
                        pkg.validity?.takeIf { it.isNotBlank() }?.let { add(it) }
                    }.joinToString("  •  "),
                    color = MutedText,
                    fontSize = 13.sp,
                )
                Spacer(Modifier.height(if (compact) 10.dp else 14.dp))
                Divider(color = PanelBorder, thickness = 1.dp)
                Spacer(Modifier.height(if (compact) 10.dp else 14.dp))
                val hasDiscount = pkg.oldPrice != null && pkg.oldPrice > pkg.price
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(
                        "$${"%.2f".format(pkg.price)}",
                        color = DalabGreen,
                        fontWeight = FontWeight.Black,
                        fontSize = if (compact) 26.sp else 30.sp,
                    )
                    if (hasDiscount) {
                        Spacer(Modifier.width(10.dp))
                        Text(
                            "$${"%.2f".format(pkg.oldPrice)}",
                            color = MutedText,
                            fontSize = if (compact) 15.sp else 17.sp,
                            textDecoration = TextDecoration.LineThrough,
                            modifier = Modifier.padding(bottom = 4.dp),
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(gap))
        PhoneInputField(
            label = LocalizationManager.tr("Number sending payment", "Lambarka Lacagta Ka Diraysid"),
            value = senderPhone,
            onValueChange = { senderPhone = it },
            showError = attemptedSubmit && senderPhone.isBlank(),
            compact = compact,
        )
        Spacer(Modifier.height(if (compact) 8.dp else 12.dp))
        PhoneInputField(
            label = LocalizationManager.tr("Receiver number", "Lambarka Lacagta u Rabtid"),
            value = receiverPhone,
            onValueChange = { receiverPhone = it },
            showError = attemptedSubmit && receiverPhone.isBlank(),
            compact = compact,
        )

        Spacer(Modifier.height(if (compact) 8.dp else 12.dp))
        ScheduleRechargeSection(
            enabled = scheduleEnabled,
            onEnabledChange = { checked ->
                scheduleEnabled = checked
                if (!checked) {
                    scheduledDate = null
                    scheduledTime = null
                }
            },
            scheduledDate = scheduledDate,
            scheduledTime = scheduledTime,
            onPickDate = { showDatePicker = true },
            showTooSoonError = attemptedSubmit && (scheduleTooSoon || scheduleMissing),
            compact = compact,
        )

        if (error != null) {
            Spacer(Modifier.height(8.dp))
            Text(error!!, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
        }
        if (queued) {
            Spacer(Modifier.height(8.dp))
            Text(
                "You're offline — this order will be placed automatically once you're back online.",
                color = DalabGreen,
                fontSize = 12.sp,
            )
        }

        Spacer(Modifier.weight(1f))

        val payEnabled = !submitting && !queued
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(buttonHeight)
                .clip(RoundedCornerShape(28.dp))
                .background(
                    if (payEnabled) Brush.horizontalGradient(listOf(DalabGreen, Color(0xFF0F9E76)))
                    else Brush.horizontalGradient(listOf(Color(0xFF3A4257), Color(0xFF3A4257)))
                )
                .clickable(enabled = payEnabled) {
                    attemptedSubmit = true
                    if (senderPhone.isBlank() || receiverPhone.isBlank()) {
                        return@clickable
                    }
                    if (scheduleMissing || scheduleTooSoon) {
                        return@clickable
                    }
                    error = null
                    submitting = true
                    val request = CreateOrderRequest(
                        companyId = company.id,
                        packageId = pkg.id,
                        senderPhone = senderPhone.trim(),
                        receiverPhone = receiverPhone.trim(),
                        paymentMethod = wallet.name,
                        clientRequestId = clientRequestId,
                        scheduledAt = scheduledInstant?.toString(),
                    )
                    scope.launch {
                        // Re-fetch the wallet fresh rather than trusting whatever was
                        // loaded when the payment-method screen first opened — a Super
                        // Admin change mid-checkout must still take effect. The payment
                        // number here is always the WALLET's OWN provider's number
                        // (server-joined via payment_wallets.company_id), independent of
                        // which company's package is being purchased — cross-provider
                        // payment (pay via one telecom, buy from another) is intentional.
                        val freshWallet = try {
                            ApiClient.service.getPaymentWallets().body()?.firstOrNull { it.id == wallet.id }
                        } catch (e: Exception) {
                            null
                        }
                        val freshPrefix = freshWallet?.dialPrefix ?: wallet.dialPrefix
                        val freshPayNumber = freshWallet?.paymentNumber?.takeIf { it.isNotBlank() }
                            ?: wallet.paymentNumber?.takeIf { it.isNotBlank() }

                        val dialTarget = if (freshPayNumber != null) {
                            "*$freshPrefix*$freshPayNumber*${"%.2f".format(pkg.price)}#"
                        } else {
                            null
                        }
                        if (dialTarget != null) {
                            context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(dialTarget))))
                        }

                        try {
                            val response = RetryClassifier.requireSuccessful(ApiClient.service.createOrder(request))
                            val order = response.body()
                            if (order != null) {
                                onOrderCreated(order)
                            } else {
                                error = "Couldn't place this order. Please try again."
                            }
                        } catch (e: Exception) {
                            if (RetryClassifier.isRetryable(e)) {
                                PendingActionQueue.enqueue(
                                    id = UUID.randomUUID().toString(),
                                    type = PendingActionQueue.Type.ORDER_CREATE,
                                    payload = OrderCreateAction(request),
                                )
                                queued = true
                            } else {
                                error = "Couldn't place this order. Please try again."
                            }
                        }
                        submitting = false
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (submitting) {
                    CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                } else {
                    Icon(Icons.Filled.Call, contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
                }
                Spacer(Modifier.width(10.dp))
                Text(
                    if (submitting) "Processing..." else if (queued) "Queued" else "Pay Now",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 17.sp,
                )
            }
        }
    }

    if (showDatePicker) {
        ScheduleDatePickerDialog(
            initialDate = scheduledDate,
            onDismiss = { showDatePicker = false },
            onDatePicked = { picked ->
                scheduledDate = picked
                showDatePicker = false
                showTimePicker = true
            },
        )
    }

    if (showTimePicker) {
        ScheduleTimePickerDialog(
            initialTime = scheduledTime,
            onDismiss = { showTimePicker = false },
            onTimePicked = { picked ->
                scheduledTime = picked
                showTimePicker = false
            },
        )
    }
}

@Composable
private fun PhoneInputField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    showError: Boolean,
    compact: Boolean,
) {
    Column {
        Text(label, color = MutedText, fontSize = 12.sp)
        Spacer(Modifier.height(4.dp))
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = { Text("6XXXXXXX", color = MutedText) },
            singleLine = true,
            isError = showError,
            supportingText = if (showError) {
                { Text("Please enter your number", color = MaterialTheme.colorScheme.error, fontSize = 11.sp) }
            } else null,
            shape = RoundedCornerShape(14.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = DalabGreen,
                unfocusedBorderColor = PanelBorder,
                focusedTextColor = Color.White,
                unfocusedTextColor = Color.White,
                cursorColor = DalabGreen,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(if (compact) 54.dp else 58.dp),
        )
    }
}

/**
 * Optional toggle deferring WHEN the provider-side USSD/data delivery
 * happens — payment itself is unaffected, still collected immediately via
 * the existing wallet-dial flow above. When enabled, tapping the date row
 * opens a date picker, then (via onPickDate -> showDatePicker in the
 * caller) a time picker; the chosen date/time is formatted for display here
 * but combined into a single Instant by the caller.
 */
@Composable
private fun ScheduleRechargeSection(
    enabled: Boolean,
    onEnabledChange: (Boolean) -> Unit,
    scheduledDate: LocalDate?,
    scheduledTime: LocalTime?,
    onPickDate: () -> Unit,
    showTooSoonError: Boolean,
    compact: Boolean,
) {
    Surface(
        color = PanelBg,
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, PanelBorder),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = if (compact) 10.dp else 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        LocalizationManager.tr("Schedule Recharge", "Jadwal Dib-u-shubid"),
                        color = Color.White,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 14.sp,
                    )
                    Text(
                        LocalizationManager.tr(
                            "Pay now, deliver later at a time you choose",
                            "Bixi hadda, keen wakhtiga aad doorato",
                        ),
                        color = MutedText,
                        fontSize = 11.sp,
                    )
                }
                Switch(
                    checked = enabled,
                    onCheckedChange = onEnabledChange,
                    colors = SwitchDefaults.colors(checkedTrackColor = DalabGreen),
                )
            }
            if (enabled) {
                Spacer(Modifier.height(8.dp))
                val label = if (scheduledDate != null && scheduledTime != null) {
                    val dateText = scheduledDate.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
                    val timeText = scheduledTime.format(DateTimeFormatter.ofPattern("h:mm a"))
                    "$dateText  •  $timeText"
                } else {
                    LocalizationManager.tr("Tap to choose date & time", "Taabo si aad u dooratid taariikhda & saacadda")
                }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(ScreenBg)
                        .clickable(onClick = onPickDate)
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                ) {
                    Text(label, color = Color.White, fontSize = 13.sp, modifier = Modifier.weight(1f))
                }
                if (showTooSoonError) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        LocalizationManager.tr(
                            "Choose a date/time at least 5 minutes from now",
                            "Dooro taariikh/saacad ugu yaraan 5 daqiiqo hadda ka dib",
                        ),
                        color = MaterialTheme.colorScheme.error,
                        fontSize = 11.sp,
                    )
                }
            }
        }
    }
}

internal fun parseColorOrDefault(hex: String, fallback: Color): Color = try {
    Color(android.graphics.Color.parseColor(hex))
} catch (_: Exception) {
    fallback
}
