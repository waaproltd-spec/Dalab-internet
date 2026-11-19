package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.dalab.internet.data.CompanyProfitOverview
import com.dalab.internet.data.CompanyProfitRow
import com.dalab.internet.data.CompanyProfitUpdate
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Company Commission & Profit: each network's Commission %, Discount % and
 * Profit % (set here), and what completed orders earned with them:
 * net commission = sales x (commission - discount), profit = sales x profit.
 * Only agents the Owner gave the "Commission & profit" service see this.
 */
@Composable
fun CompanyProfitScreen(onBack: () -> Unit) {
    var period by remember { mutableStateOf("month") }
    var data by remember { mutableStateOf<CompanyProfitOverview?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<CompanyProfitRow?>(null) }
    var attempt by remember { mutableStateOf(0) }

    LaunchedEffect(period, attempt) {
        loading = true
        error = null
        try {
            val r = ApiClient.service.getCompanyProfit(period)
            if (r.isSuccessful) data = r.body()
            else error = serverMessage(r.errorBody()?.string()) ?: "Couldn't load (error ${r.code()})."
        } catch (_: Exception) {
            error = "Couldn't load. Check your connection."
        }
        loading = false
    }

    val totals = data?.totals
    Scaffold(
        topBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(WaaproHeaderBrush, RoundedCornerShape(bottomStart = 26.dp, bottomEnd = 26.dp))
                    .padding(start = 8.dp, end = 8.dp, top = 10.dp, bottom = 18.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                    Text("Commission & Profit", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp, modifier = Modifier.weight(1f))
                    IconButton(onClick = { attempt++ }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = Color.White) }
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(horizontal = 8.dp)) {
                    listOf("today" to "Today", "month" to "This month", "all" to "All time").forEach { (key, label) ->
                        val on = period == key
                        Surface(
                            shape = RoundedCornerShape(50),
                            color = if (on) WaaproGold else Color.White.copy(alpha = 0.14f),
                            modifier = Modifier.clip(RoundedCornerShape(50)).clickable { period = key },
                        ) {
                            Text(label, color = if (on) WaaproNavy else Color.White, fontWeight = FontWeight.Bold, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp))
                        }
                    }
                }
                Spacer(Modifier.height(14.dp))
                Column(Modifier.padding(horizontal = 8.dp)) {
                    Text("Total earned", color = Color.White.copy(alpha = 0.8f), fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
                    Text(usd(totals?.total ?: 0.0), color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 32.sp)
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        HeaderFigure("Net commission", usd(totals?.netCommission ?: 0.0), Modifier.weight(1f))
                        HeaderFigure("Profit", usd(totals?.profit ?: 0.0), Modifier.weight(1f))
                        HeaderFigure("Orders", "${totals?.orders ?: 0}", Modifier.weight(1f))
                    }
                }
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            val rows = data?.companies.orEmpty()
            when {
                loading && data == null -> CircularProgressIndicator(color = WaaproNavy, modifier = Modifier.align(Alignment.Center))
                error != null && data == null -> Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(error!!, color = StatusRed)
                    Spacer(Modifier.height(10.dp))
                    Button(onClick = { attempt++ }, colors = ButtonDefaults.buttonColors(containerColor = WaaproNavy)) { Text("Retry") }
                }
                else -> LazyColumn(
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(rows, key = { it.companyId }) { row -> NetworkProfitCard(row) { editing = row } }
                }
            }
        }
    }

    editing?.let { row ->
        EditTermsDialog(
            row = row,
            onDismiss = { editing = null },
            onSaved = { editing = null; attempt++ },
        )
    }
}

private fun usd(n: Double) = "$" + "%,.2f".format(n)
private fun pctText(n: Double?) = if (n == null) "—" else (if (n % 1.0 == 0.0) "${n.toInt()}%" else "${"%.2f".format(n).trimEnd('0').trimEnd('.')}%")
private fun serverMessage(body: String?): String? = try { body?.let { JSONObject(it).optString("error").ifBlank { null } } } catch (_: Exception) { null }
private fun brand(hex: String?): Color = try { hex?.let { Color(android.graphics.Color.parseColor(it)) } ?: WaaproBlue } catch (_: Exception) { WaaproBlue }

@Composable
private fun HeaderFigure(label: String, value: String, modifier: Modifier) {
    Surface(shape = RoundedCornerShape(16.dp), color = Color.White.copy(alpha = 0.14f), modifier = modifier) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 9.dp)) {
            Text(value, color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, maxLines = 1)
            Text(label, color = Color.White.copy(alpha = 0.85f), fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        }
    }
}

@Composable
private fun PctBox(label: String, value: Double?, modifier: Modifier, ink: Color = WaaproNavy) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(14.dp))
            .background(ink.copy(alpha = 0.07f))
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Text(pctText(value), fontWeight = FontWeight.ExtraBold, fontSize = 17.sp, color = if (value == null) WaaproMuted else ink)
        Text(label, color = WaaproMuted, fontSize = 11.sp, maxLines = 1)
    }
}

/** One network: its three percentages, then what its completed orders earned. */
@Composable
private fun NetworkProfitCard(row: CompanyProfitRow, onEdit: () -> Unit) {
    val color = brand(row.colorHex)
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 2.dp,
        modifier = Modifier.fillMaxWidth().border(1.dp, WaaproBorder, RoundedCornerShape(20.dp)),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(40.dp).clip(CircleShape).background(color), contentAlignment = Alignment.Center) {
                    Text((row.name.firstOrNull() ?: '?').uppercase(), color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 18.sp)
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(row.name, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        if (row.configured) "${row.orders} successful order${if (row.orders == 1) "" else "s"} · ${usd(row.sales)}" else "Not set",
                        color = if (row.configured) WaaproMuted else StatusAmber, fontSize = 12.5.sp,
                    )
                }
                FilledTonalButton(onClick = onEdit, shape = RoundedCornerShape(14.dp), contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp)) {
                    Icon(Icons.Filled.Edit, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Edit", fontWeight = FontWeight.Bold)
                }
            }
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PctBox("Commission", row.commissionPct, Modifier.weight(1f))
                PctBox("Discount", row.discountPct, Modifier.weight(1f))
                PctBox("Profit", row.profitPct, Modifier.weight(1f))
            }
            if (row.configured) {
                HorizontalDivider(Modifier.padding(vertical = 12.dp), color = WaaproBorder)
                Row {
                    EarnFigure("Net commission ${pctText(row.netCommissionPct)}", usd(row.netCommission), Modifier.weight(1f))
                    EarnFigure("Profit ${pctText(row.profitPct)}", usd(row.profit), Modifier.weight(1f))
                    EarnFigure("Total", usd(row.total), Modifier.weight(1f), StatusGreen)
                }
            }
        }
    }
}

@Composable
private fun EarnFigure(label: String, value: String, modifier: Modifier, ink: Color = Color.Unspecified) {
    Column(modifier) {
        Text(value, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, color = ink, maxLines = 1)
        Text(label, color = WaaproMuted, fontSize = 11.sp, maxLines = 1)
    }
}

private fun plain(n: Double?): String = when {
    n == null -> ""
    n % 1.0 == 0.0 -> n.toInt().toString()
    else -> n.toString()
}

private fun parsePct(s: String): Double? = s.trim().replace(',', '.').toDoubleOrNull()

@Composable
private fun EditTermsDialog(row: CompanyProfitRow, onDismiss: () -> Unit, onSaved: () -> Unit) {
    var commission by remember { mutableStateOf(plain(row.commissionPct)) }
    var discount by remember { mutableStateOf(plain(row.discountPct)) }
    var profit by remember { mutableStateOf(plain(row.profitPct)) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // Live example: what a $1 order earns with these numbers.
    val c = parsePct(commission) ?: 0.0
    val d = parsePct(discount) ?: 0.0
    val p = parsePct(profit) ?: 0.0
    val netPct = c - d
    val badInput = listOf(commission, discount, profit).any { it.isNotBlank() && (parsePct(it) == null || parsePct(it)!! < 0 || parsePct(it)!! > 100) }
    val discountTooBig = d > c

    Dialog(onDismissRequest = { if (!saving) onDismiss() }) {
        Surface(shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.padding(20.dp)) {
                Text(row.name, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp)
                Spacer(Modifier.height(14.dp))
                PctField("Commission %", commission) { commission = it }
                Spacer(Modifier.height(10.dp))
                PctField("Discount %", discount) { discount = it }
                Spacer(Modifier.height(10.dp))
                PctField("Profit %", profit) { profit = it }
                Spacer(Modifier.height(14.dp))
                Surface(shape = RoundedCornerShape(16.dp), color = WaaproNavy.copy(alpha = 0.06f), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Text("A \$1 order earns", color = WaaproMuted, fontSize = 12.sp)
                        Text(
                            "${usd(netPct.coerceAtLeast(0.0) / 100)} + ${usd(p / 100)} = ${usd((netPct.coerceAtLeast(0.0) + p) / 100)}",
                            fontWeight = FontWeight.ExtraBold, fontSize = 17.sp, color = WaaproNavy,
                        )
                        Text("Net commission ${pctText(netPct.coerceAtLeast(0.0))} + Profit ${pctText(p)}", color = WaaproMuted, fontSize = 11.5.sp)
                    }
                }
                val problem = error ?: when {
                    badInput -> "Use numbers from 0 to 100."
                    discountTooBig -> "Discount can't be more than the commission."
                    else -> null
                }
                if (problem != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(problem, color = StatusRed, fontSize = 13.sp)
                }
                Spacer(Modifier.height(16.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss, enabled = !saving) { Text("Cancel") }
                    Spacer(Modifier.width(8.dp))
                    Button(
                        enabled = !saving && !badInput && !discountTooBig,
                        colors = ButtonDefaults.buttonColors(containerColor = WaaproNavy),
                        shape = RoundedCornerShape(14.dp),
                        onClick = {
                            saving = true
                            error = null
                            scope.launch {
                                try {
                                    val r = ApiClient.service.updateCompanyProfit(
                                        row.companyId,
                                        CompanyProfitUpdate(commission.trim(), discount.trim(), profit.trim()),
                                    )
                                    if (r.isSuccessful) onSaved()
                                    else error = serverMessage(r.errorBody()?.string()) ?: "Couldn't save (error ${r.code()})."
                                } catch (_: Exception) {
                                    error = "Couldn't save. Check your connection."
                                }
                                saving = false
                            }
                        },
                    ) { Text(if (saving) "Saving..." else "Save", fontWeight = FontWeight.Bold) }
                }
            }
        }
    }
}

@Composable
private fun PctField(label: String, value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = { v -> onChange(v.filter { it.isDigit() || it == '.' || it == ',' }.take(6)) },
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        suffix = { Text("%") },
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth(),
    )
}
