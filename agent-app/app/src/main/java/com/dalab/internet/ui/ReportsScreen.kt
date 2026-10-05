package com.dalab.internet.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MonetizationOn
import androidx.compose.material.icons.filled.Paid
import androidx.compose.material.icons.filled.Percent
import androidx.compose.material.icons.filled.Sell
import androidx.compose.material.icons.filled.TrendingUp
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.R
import com.dalab.internet.data.AgentReportDashboard
import com.dalab.internet.data.CompanyReport
import com.dalab.internet.data.ReportCompanyCard
import com.dalab.internet.data.ReportPackageRow
import com.dalab.internet.data.ReportPriceExample
import com.dalab.internet.data.ReportProfitBreakdown
import com.dalab.internet.data.ReportStatusSplit
import com.dalab.internet.network.ApiClient
import com.dalab.internet.ui.theme.DalabBlue
import com.dalab.internet.ui.theme.DalabDangerRed
import com.dalab.internet.ui.theme.DalabInfoBlue
import com.dalab.internet.ui.theme.DalabOutline
import com.dalab.internet.ui.theme.DalabSoftBlue
import com.dalab.internet.ui.theme.DalabSuccessGreen
import com.dalab.internet.ui.theme.DalabSurfaceTint
import com.dalab.internet.ui.theme.DalabWarningAmber
import com.dalab.internet.ui.theme.DalabWhite
import java.util.Locale

// The Agent App's own colors (ui/theme/DalabColors.kt): white background,
// DALAB dark blue for text and the brand, and the shared status colors.
private val RBg = DalabWhite
private val RCard = DalabSurfaceTint
private val RCardBorder = DalabOutline.copy(alpha = 0.6f)
private val RText = DalabBlue
private val RMuted = DalabBlue.copy(alpha = 0.62f)
private val RGreen = DalabSuccessGreen
private val RRed = DalabDangerRed
private val RAmber = DalabWarningAmber
private val RBlue = DalabInfoBlue

private data class ReportRange(val value: String, val label: String)

private val REPORT_RANGES = listOf(
    ReportRange("today", "Today"),
    ReportRange("7days", "7 Days"),
    ReportRange("30days", "30 Days"),
    ReportRange("all", "All time"),
)

private fun usd(v: Double): String = (if (v < 0) "-$" else "$") + String.format(Locale.US, "%.2f", kotlin.math.abs(v))
private fun percent(v: Double): String = String.format(Locale.US, "%.1f%%", v)

private fun parseColor(hex: String?, fallback: Color): Color = try {
    if (hex.isNullOrBlank()) fallback else Color(android.graphics.Color.parseColor(hex))
} catch (_: Exception) {
    fallback
}

/** A small generic loader for both report screens: (re)loads whenever
 * [key] changes, keeping the last good result on screen while reloading. */
@Composable
private fun <T> rememberReport(key: Any, fetch: suspend () -> retrofit2.Response<T>): Triple<T?, Boolean, String?> {
    var data by remember { mutableStateOf<T?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(key) {
        loading = true
        try {
            val response = fetch()
            if (response.isSuccessful) {
                data = response.body()
                error = null
            } else {
                error = "Couldn't load the report. Check your connection."
            }
        } catch (_: Exception) {
            error = "Couldn't load the report. Check your connection."
        }
        loading = false
    }
    return Triple(data, loading, error)
}

/** The Agent App "Reports" dashboard -- GET /agent/reports/dashboard, all
 * real figures for this agent's orders: summary cards, order status donut,
 * each company on its own card (tap for its own report), and the profit
 * breakdown (cost + markup = selling - discount = final - cost = profit). */
@Composable
fun ReportsScreen(onBack: () -> Unit) {
    var range by remember { mutableStateOf("all") }
    var openCompany by remember { mutableStateOf<ReportCompanyCard?>(null) }

    val company = openCompany
    if (company != null) {
        BackHandler { openCompany = null }
        CompanyReportScreen(company = company, initialRange = range, onBack = { openCompany = null })
        return
    }

    val (report, loading, error) = rememberReport(range) { ApiClient.service.getReportDashboard(range) }

    Box(Modifier.fillMaxSize().background(RBg)) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 28.dp)) {
            item { BrandHeader(onBack = onBack) }
            item {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Reports", color = RText, fontSize = 30.sp, fontWeight = FontWeight.Black)
                        Text("A summary of your order activity.", color = RMuted, fontSize = 14.sp)
                    }
                    RangeDropdown(range = range, onChange = { range = it })
                }
            }
            if (error != null) item { ErrorLine(error) }
            val current = report
            if (current == null) {
                item { LoadingOrEmpty(loading) }
            } else {
                item { SummaryGrid(current.totalOrders, current.successfulValue, current.totalProfit, current.totalDiscount) }
                item { SectionTitle("Order Status") }
                item { StatusCard(current.status, current.totalOrders) }
                item { SectionTitle("By Network") }
                val companies = current.companies.orEmpty()
                if (companies.isEmpty()) item { Muted("No companies yet.") }
                items(companies.size) { i -> CompanyCard(companies[i], onClick = { openCompany = companies[i] }) }
                item { SectionTitle("Profit") }
                item { ProfitCard(current.profitBreakdown) }
            }
        }
    }
}

@Composable
private fun CompanyReportScreen(company: ReportCompanyCard, initialRange: String, onBack: () -> Unit) {
    var range by remember { mutableStateOf(initialRange) }
    val (report, loading, error) = rememberReport(range) { ApiClient.service.getCompanyReport(company.companyId, range) }
    val brand = parseColor(company.colorHex, DalabBlue)

    Box(Modifier.fillMaxSize().background(RBg)) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 28.dp)) {
            item {
                Row(
                    modifier = Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 8.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = RText) }
                    CompanyLogo(company.companyId, brand, 44.dp)
                    Spacer(Modifier.width(12.dp))
                    Text(
                        "${company.companyName} Reports",
                        color = RText,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Black,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            item {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    REPORT_RANGES.forEach { r ->
                        val selected = r.value == range
                        Surface(
                            color = if (selected) DalabBlue else RCard,
                            shape = RoundedCornerShape(12.dp),
                            border = BorderStroke(1.dp, if (selected) DalabBlue else RCardBorder),
                            modifier = Modifier.weight(1f).clickable { range = r.value },
                        ) {
                            Text(
                                r.label,
                                color = if (selected) Color.White else RText,
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                                maxLines = 1,
                                modifier = Modifier.padding(vertical = 10.dp).fillMaxWidth(),
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                            )
                        }
                    }
                }
            }
            if (error != null) item { ErrorLine(error) }
            val current = report
            if (current == null) {
                item { LoadingOrEmpty(loading) }
            } else {
                item { Spacer(Modifier.height(6.dp)) }
                item { SummaryGrid(current.totalOrders, current.successfulValue, current.totalProfit, current.totalDiscount) }
                item { SectionTitle("Order Status", "(${company.companyName})") }
                item { StatusCard(current.status, current.totalOrders) }
                item { SectionTitle("Package Performance") }
                val packages = current.packages.orEmpty()
                if (packages.isEmpty()) {
                    item { Muted("No orders for ${company.companyName} in this period.") }
                } else {
                    item {
                        DarkCard(Modifier.padding(horizontal = 16.dp)) {
                            packages.forEachIndexed { i, p ->
                                if (i > 0) Divider(color = RCardBorder)
                                PackageRow(p, brand)
                            }
                        }
                    }
                }
                current.priceExample?.let { ex ->
                    item { SectionTitle("Price Example", "(${company.companyName})") }
                    item { PriceExampleCard(company.companyId, brand, ex) }
                }
                item { SectionTitle("Profit") }
                item { ProfitCard(current.profitBreakdown) }
            }
        }
    }
}

@Composable
private fun BrandHeader(onBack: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(bottomStart = 26.dp, bottomEnd = 26.dp))
            .background(Brush.linearGradient(listOf(DalabBlue, DalabSoftBlue)))
            .statusBarsPadding()
            .padding(horizontal = 8.dp, vertical = 14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
            Image(
                painter = painterResource(R.drawable.dalab_logo),
                contentDescription = null,
                modifier = Modifier.size(34.dp).clip(RoundedCornerShape(8.dp)),
            )
            Spacer(Modifier.width(10.dp))
            Text("DALAB AGENT", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Black)
        }
    }
}

@Composable
private fun RangeDropdown(range: String, onChange: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Surface(
            color = RCard,
            shape = RoundedCornerShape(14.dp),
            border = BorderStroke(1.dp, RCardBorder),
            modifier = Modifier.clickable { open = true },
        ) {
            Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.CalendarMonth, contentDescription = null, tint = RText, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(REPORT_RANGES.first { it.value == range }.label, color = RText, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = RText)
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            REPORT_RANGES.forEach { r ->
                DropdownMenuItem(text = { Text(r.label) }, onClick = { open = false; onChange(r.value) })
            }
        }
    }
}

@Composable
private fun DarkCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        color = RCard,
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, RCardBorder),
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp), content = content)
    }
}

@Composable
private fun SummaryGrid(totalOrders: Int, successfulValue: Double, totalProfit: Double, totalDiscount: Double) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatTile(Icons.Filled.Description, RBlue, "$totalOrders", "Total Orders", Modifier.weight(1f))
            StatTile(Icons.Filled.MonetizationOn, RGreen, usd(successfulValue), "Successful Value", Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatTile(Icons.Filled.BarChart, RAmber, usd(totalProfit), "Total Profit", Modifier.weight(1f))
            StatTile(Icons.Filled.Percent, RRed, usd(totalDiscount), "Total Discount", Modifier.weight(1f))
        }
    }
}

@Composable
private fun StatTile(icon: ImageVector, color: Color, value: String, label: String, modifier: Modifier) {
    Surface(color = RCard, shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, RCardBorder), modifier = modifier) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).background(color, RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(24.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(value, color = RText, fontSize = 20.sp, fontWeight = FontWeight.Black, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(label, color = RMuted, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun SectionTitle(title: String, suffix: String? = null) {
    Row(Modifier.padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 8.dp), verticalAlignment = Alignment.Bottom) {
        Text(title, color = RText, fontSize = 20.sp, fontWeight = FontWeight.Black)
        if (suffix != null) {
            Spacer(Modifier.width(6.dp))
            Text(suffix, color = RMuted, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun StatusCard(status: ReportStatusSplit, total: Int) {
    DarkCard(Modifier.padding(horizontal = 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(132.dp), contentAlignment = Alignment.Center) {
                Donut(
                    listOf(status.sent.toFloat() to RGreen, status.failed.toFloat() to RRed, status.cancelled.toFloat() to RAmber),
                    Modifier.fillMaxSize(),
                )
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("$total", color = RText, fontSize = 28.sp, fontWeight = FontWeight.Black)
                    Text("Total", color = RMuted, fontSize = 13.sp)
                }
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                LegendRow(RGreen, "Sent successfully", status.sent, status.sentPercent)
                LegendRow(RRed, "Failed", status.failed, status.failedPercent)
                LegendRow(RAmber, "Cancelled", status.cancelled, status.cancelledPercent)
            }
        }
    }
}

/** A donut of [slices] (value to color); an empty ring when all are 0. */
@Composable
private fun Donut(slices: List<Pair<Float, Color>>, modifier: Modifier) {
    val total = slices.sumOf { it.first.toDouble() }.toFloat()
    Canvas(modifier) {
        val stroke = size.minDimension * 0.14f
        val inset = stroke / 2
        val arcSize = Size(size.width - stroke, size.height - stroke)
        val topLeft = Offset(inset, inset)
        drawArc(RCardBorder, 0f, 360f, false, topLeft, arcSize, style = Stroke(stroke))
        if (total <= 0f) return@Canvas
        var start = -90f
        slices.forEach { (value, color) ->
            if (value <= 0f) return@forEach
            val sweep = 360f * value / total
            drawArc(color, start, sweep, false, topLeft, arcSize, style = Stroke(stroke, cap = StrokeCap.Butt))
            start += sweep
        }
    }
}

@Composable
private fun LegendRow(color: Color, label: String, count: Int, pct: Double) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(11.dp).background(color, CircleShape))
        Spacer(Modifier.width(8.dp))
        Text(label, color = RText, fontSize = 14.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text("$count", color = RText, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        Text(" (${percent(pct)})", color = RMuted, fontSize = 13.sp)
    }
}

@Composable
private fun CompanyLogo(companyId: String, brand: Color, size: androidx.compose.ui.unit.Dp) {
    val res = logoResFor(companyId)
    Box(
        Modifier.size(size).clip(RoundedCornerShape(12.dp)).background(if (res == R.drawable.dalab_logo) brand else Color.White),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = painterResource(res),
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize().padding(4.dp),
        )
    }
}

@Composable
private fun CompanyCard(c: ReportCompanyCard, onClick: () -> Unit) {
    val brand = parseColor(c.colorHex, DalabBlue)
    Surface(
        color = RCard,
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, RCardBorder),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 5.dp).clickable(onClick = onClick),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CompanyLogo(c.companyId, brand, 54.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(c.companyName, color = RText, fontSize = 17.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.height(6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Metric("${c.totalOrders}", "Orders", Modifier.weight(1f))
                        Metric(usd(c.successfulValue), "Value", Modifier.weight(1.2f))
                        Metric(usd(c.totalProfit), "Profit", Modifier.weight(1.2f))
                        Metric(usd(c.totalDiscount), "Discount", Modifier.weight(1.2f))
                    }
                }
                Icon(Icons.Filled.ChevronRight, contentDescription = "Open ${c.companyName}", tint = RMuted)
            }
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f).height(8.dp).clip(RoundedCornerShape(4.dp)).background(RCardBorder)) {
                    Box(
                        Modifier.fillMaxHeight()
                            .fillMaxWidth((c.sharePercent / 100.0).coerceIn(0.0, 1.0).toFloat())
                            .clip(RoundedCornerShape(4.dp))
                            .background(brand),
                    )
                }
                Spacer(Modifier.width(10.dp))
                Text(percent(c.sharePercent), color = RMuted, fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun Metric(value: String, label: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(value, color = RText, fontSize = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(label, color = RMuted, fontSize = 11.5.sp, maxLines = 1)
    }
}

@Composable
private fun PackageRow(p: ReportPackageRow, brand: Color) {
    Row(Modifier.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(46.dp).background(brand.copy(alpha = 0.18f), RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.Sell, contentDescription = null, tint = brand, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(p.name, color = RText, fontSize = 15.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (!p.validity.isNullOrBlank()) Text(p.validity, color = RMuted, fontSize = 12.5.sp, maxLines = 1)
        }
        Spacer(Modifier.width(8.dp))
        Column(Modifier.width(126.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row {
                MiniMetric("Orders", "${p.totalOrders}", Modifier.weight(1f))
                MiniMetric("Value", usd(p.successfulValue), Modifier.weight(1f))
            }
            Row {
                MiniMetric("Profit", usd(p.totalProfit), Modifier.weight(1f))
                MiniMetric("Discount", usd(p.totalDiscount), Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun MiniMetric(label: String, value: String, modifier: Modifier) {
    Column(modifier) {
        Text(label, color = RMuted, fontSize = 10.5.sp, maxLines = 1)
        Text(value, color = RText, fontSize = 12.5.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

private data class MoneyLine(val icon: ImageVector, val color: Color, val title: String, val subtitle: String, val value: String, val strong: Boolean = false)

@Composable
private fun MoneyLines(lines: List<MoneyLine>) {
    Surface(color = DalabWhite, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
        Column {
            lines.forEachIndexed { i, line ->
                if (i > 0) Divider(color = DalabSurfaceTint)
                Row(Modifier.padding(horizontal = 12.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(line.icon, contentDescription = null, tint = line.color, modifier = Modifier.size(24.dp))
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(line.title, color = if (line.strong) line.color else DalabBlue, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                        Text(line.subtitle, color = RMuted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Text(
                        line.value,
                        color = if (line.strong) line.color else DalabBlue,
                        fontSize = if (line.strong) 18.sp else 16.sp,
                        fontWeight = FontWeight.Black,
                    )
                }
            }
        }
    }
}

private fun moneyLines(companyCost: Double, markup: Double, selling: Double, discount: Double, final: Double, profit: Double) = listOf(
    MoneyLine(Icons.Filled.Business, RBlue, "Company Cost", "What the company is paid", usd(companyCost)),
    MoneyLine(Icons.Filled.TrendingUp, RGreen, "Markup", "Added on top of company cost", usd(markup)),
    MoneyLine(Icons.Filled.Sell, DalabBlue, "Selling Price", "Company cost + markup", usd(selling)),
    MoneyLine(Icons.Filled.Percent, RRed, "Discount Given", "Taken off the selling price", usd(discount)),
    MoneyLine(Icons.Filled.Paid, RAmber, "Final Price", "Selling price - discount (what was paid)", usd(final)),
    MoneyLine(Icons.Filled.BarChart, if (profit >= 0) RGreen else RRed, "Actual Profit", "Final price - company cost", usd(profit), strong = true),
)

@Composable
private fun ProfitCard(b: ReportProfitBreakdown) {
    DarkCard(Modifier.padding(horizontal = 16.dp)) {
        Text("From successfully sent orders in this period", color = RMuted, fontSize = 12.5.sp)
        Spacer(Modifier.height(10.dp))
        MoneyLines(moneyLines(b.companyCost, b.markup, b.sellingPrice, b.discount, b.finalPrice, b.actualProfit))
    }
}

@Composable
private fun PriceExampleCard(companyId: String, brand: Color, ex: ReportPriceExample) {
    Surface(
        color = RCard,
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, DalabBlue.copy(alpha = 0.35f)),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CompanyLogo(companyId, brand, 34.dp)
                Spacer(Modifier.width(10.dp))
                Text(ex.packageName, color = RText, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (!ex.validity.isNullOrBlank()) {
                    Text(" (${ex.validity})", color = RMuted, fontSize = 14.sp, maxLines = 1)
                }
            }
            Spacer(Modifier.height(10.dp))
            MoneyLines(moneyLines(ex.companyCost, ex.markup, ex.sellingPrice, ex.discount, ex.finalPrice, ex.actualProfit))
        }
    }
}

@Composable
private fun ErrorLine(message: String) {
    Text(message, color = RRed, fontSize = 14.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
}

@Composable
private fun Muted(message: String) {
    Text(message, color = RMuted, fontSize = 14.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
}

@Composable
private fun LoadingOrEmpty(loading: Boolean) {
    Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
        if (loading) CircularProgressIndicator(color = DalabBlue) else Text("No data yet.", color = RMuted)
    }
}
