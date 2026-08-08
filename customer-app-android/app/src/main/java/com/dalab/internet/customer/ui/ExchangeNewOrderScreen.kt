package com.dalab.internet.customer.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.data.CreateExchangeOrderRequest
import com.dalab.internet.customer.data.ExchangeCorridor
import com.dalab.internet.customer.data.ExchangeOrder
import com.dalab.internet.customer.data.ExchangeQuote
import com.dalab.internet.customer.data.ExchangeWallet
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.prefs.LocalizationManager
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

private val ScreenBg = Color(0xFF0B0F1E)
private val PanelBg = Color(0xFF141A2E)
private val PanelBorder = Color(0xFF232B45)
private val MutedText = Color(0xFF9CA3B8)
private val ExchangeBlue = Color(0xFF2E5BFF)

/**
 * Step 2 of Money Exchange: amount + live rate/fee preview + the
 * recipient's wallet number. The corridor (From/To wallet pair) is already
 * fixed from the previous screen. senderPhone is the customer's own number
 * they're paying FROM (needed for the collection-payment SMS to auto-match
 * this order); receiverPhone is the RECIPIENT's number on the To side —
 * deliberately a fresh field every time, never pre-filled from the
 * customer's profile or a previous order, exactly like Internet Store's
 * CheckoutScreen never pre-fills sender/receiver either.
 */
@Composable
fun ExchangeNewOrderScreen(
    corridor: ExchangeCorridor,
    fromWallet: ExchangeWallet?,
    toWallet: ExchangeWallet?,
    onBack: () -> Unit,
    onOrderCreated: (ExchangeOrder) -> Unit,
) {
    var amountInput by remember { mutableStateOf("") }
    var senderPhone by remember { mutableStateOf("") }
    var receiverPhone by remember { mutableStateOf("") }
    var attemptedSubmit by remember { mutableStateOf(false) }

    var quote by remember { mutableStateOf<ExchangeQuote?>(null) }
    var quoteLoading by remember { mutableStateOf(false) }
    var quoteError by remember { mutableStateOf<String?>(null) }

    var submitting by remember { mutableStateOf(false) }
    var submitError by remember { mutableStateOf<String?>(null) }
    val clientRequestId = remember { UUID.randomUUID().toString() }
    val scope = rememberCoroutineScope()

    val amount = amountInput.toDoubleOrNull()

    // Debounced live quote — re-fetches ~400ms after the customer stops
    // typing, same "don't hammer the backend on every keystroke" shape as
    // any other live-search-style field. Never trusted for the actual
    // order — POST /exchange/orders recomputes the quote itself server-side.
    LaunchedEffect(amountInput, corridor.id) {
        if (amount == null || amount <= 0) {
            quote = null
            quoteError = null
            return@LaunchedEffect
        }
        delay(400)
        quoteLoading = true
        quoteError = null
        try {
            quote = ApiClient.service.getExchangeQuote(corridor.id, amount).body()
        } catch (e: Exception) {
            quote = null
            quoteError = LocalizationManager.tr("Couldn't calculate the rate for this amount.", "Lama xisaabin qiimaha lacagtan.")
        }
        quoteLoading = false
    }

    Column(modifier = Modifier.fillMaxSize().background(ScreenBg)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
            }
            Text(LocalizationManager.tr("Exchange Details", "Faahfaahinta Wareejinta"), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            Spacer(Modifier.height(4.dp))
            Surface(color = PanelBg, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, PanelBorder), modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(fromWallet?.name ?: corridor.fromWalletName ?: "?", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    Spacer(Modifier.width(10.dp))
                    Icon(Icons.Filled.ArrowForward, contentDescription = null, tint = ExchangeBlue, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(toWallet?.name ?: corridor.toWalletName ?: "?", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                }
            }

            Spacer(Modifier.height(18.dp))
            Text(LocalizationManager.tr("Amount to send", "Lacagta aad dirayso"), color = MutedText, fontSize = 12.sp)
            Spacer(Modifier.height(4.dp))
            OutlinedTextField(
                value = amountInput,
                onValueChange = { text -> if (text.isEmpty() || text.matches(Regex("^\\d*\\.?\\d*$"))) amountInput = text },
                placeholder = { Text("0.00", color = MutedText) },
                singleLine = true,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Decimal),
                isError = attemptedSubmit && (amount == null || amount <= 0),
                shape = RoundedCornerShape(14.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = ExchangeBlue,
                    unfocusedBorderColor = PanelBorder,
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White,
                    cursorColor = ExchangeBlue,
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(14.dp))
            QuoteSummary(quote = quote, loading = quoteLoading, error = quoteError, corridor = corridor)

            Spacer(Modifier.height(18.dp))
            PhoneField(
                label = LocalizationManager.tr("Your number (paying from)", "Lambarkaaga (aad ka bixinayso)"),
                value = senderPhone,
                onValueChange = { senderPhone = it },
                showError = attemptedSubmit && senderPhone.isBlank(),
            )
            Spacer(Modifier.height(12.dp))
            PhoneField(
                label = LocalizationManager.tr("Recipient's wallet number", "Lambarka aqoonsiga qofka heli doona"),
                value = receiverPhone,
                onValueChange = { receiverPhone = it },
                showError = attemptedSubmit && receiverPhone.isBlank(),
            )
            // Explicit, visible reminder — this number is scoped to this one
            // transaction only, never saved as the customer's own account.
            Spacer(Modifier.height(6.dp))
            Text(
                LocalizationManager.tr(
                    "This is only the recipient's number for this exchange — it will not be saved to your account.",
                    "Kani waa oo kaliya lambarka qofka heli doona wareejintan — lagama kaydin doono xisaabtaada.",
                ),
                color = MutedText,
                fontSize = 11.sp,
            )

            if (submitError != null) {
                Spacer(Modifier.height(10.dp))
                Text(submitError!!, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
            }
            Spacer(Modifier.height(16.dp))
        }

        val canSubmit = !submitting && amount != null && amount > 0 && quote != null
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 14.dp)
                .height(54.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(
                    if (canSubmit) Brush.horizontalGradient(listOf(ExchangeBlue, Color(0xFF1B3FCC)))
                    else Brush.horizontalGradient(listOf(Color(0xFF3A4257), Color(0xFF3A4257)))
                )
                .clickable(enabled = canSubmit) {
                    attemptedSubmit = true
                    if (amount == null || amount <= 0 || senderPhone.isBlank() || receiverPhone.isBlank() || quote == null) return@clickable
                    submitError = null
                    submitting = true
                    scope.launch {
                        try {
                            val response = ApiClient.service.createExchangeOrder(
                                CreateExchangeOrderRequest(
                                    corridorId = corridor.id,
                                    amount = amount,
                                    senderPhone = senderPhone.trim(),
                                    receiverPhone = receiverPhone.trim(),
                                    clientRequestId = clientRequestId,
                                )
                            )
                            val order = response.body()
                            if (response.isSuccessful && order != null) {
                                onOrderCreated(order)
                            } else {
                                submitError = LocalizationManager.tr("Couldn't create this exchange. Please try again.", "Lama abuuri karin wareejintan. Fadlan isku day mar kale.")
                            }
                        } catch (e: Exception) {
                            submitError = LocalizationManager.tr("Couldn't create this exchange. Please try again.", "Lama abuuri karin wareejintan. Fadlan isku day mar kale.")
                        }
                        submitting = false
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (submitting) {
                    CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(10.dp))
                }
                Text(
                    if (submitting) LocalizationManager.tr("Creating...", "Waa la abuurayaa...")
                    else LocalizationManager.tr("Continue", "Sii wad"),
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                )
            }
        }
    }
}

@Composable
private fun QuoteSummary(quote: ExchangeQuote?, loading: Boolean, error: String?, corridor: ExchangeCorridor) {
    Surface(color = PanelBg, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, PanelBorder), modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            when {
                loading -> Text(LocalizationManager.tr("Calculating...", "Waa la xisaabinayaa..."), color = MutedText, fontSize = 13.sp)
                error != null -> Text(error, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                quote == null -> Text(
                    LocalizationManager.tr("Enter an amount to see the rate, fee, and amount received.", "Geli lacag si aad u aragto qiimaha, khidmadda, iyo lacagta la heli doono."),
                    color = MutedText,
                    fontSize = 12.sp,
                )
                else -> {
                    QuoteRow(LocalizationManager.tr("Exchange rate", "Qiimaha wareejinta"), "${quote.rate}")
                    QuoteRow(LocalizationManager.tr("Fee", "Khidmad"), "$${"%.2f".format(quote.fee)}")
                    QuoteRow(LocalizationManager.tr("You send", "Waxaad dirtaa"), "$${"%.2f".format(quote.amountSent)}")
                    Spacer(Modifier.height(4.dp))
                    Divider(color = PanelBorder)
                    Spacer(Modifier.height(4.dp))
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(LocalizationManager.tr("Recipient receives", "Qofka helaya wuxuu heli doonaa"), color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                        Text("$${"%.2f".format(quote.amountReceived)}", color = ExchangeBlue, fontWeight = FontWeight.Black, fontSize = 16.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun QuoteRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = MutedText, fontSize = 12.sp)
        Text(value, color = Color.White, fontSize = 12.sp)
    }
}

@Composable
private fun PhoneField(label: String, value: String, onValueChange: (String) -> Unit, showError: Boolean) {
    Column {
        Text(label, color = MutedText, fontSize = 12.sp)
        Spacer(Modifier.height(4.dp))
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = { Text("6XXXXXXXX", color = MutedText) },
            singleLine = true,
            isError = showError,
            supportingText = if (showError) {
                { Text(LocalizationManager.tr("Required", "Waa lagama maarmaan"), color = MaterialTheme.colorScheme.error, fontSize = 11.sp) }
            } else null,
            shape = RoundedCornerShape(14.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = ExchangeBlue,
                unfocusedBorderColor = PanelBorder,
                focusedTextColor = Color.White,
                unfocusedTextColor = Color.White,
                cursorColor = ExchangeBlue,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
