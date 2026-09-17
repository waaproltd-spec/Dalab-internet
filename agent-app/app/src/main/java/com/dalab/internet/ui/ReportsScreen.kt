package com.dalab.internet.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Receipt
import androidx.compose.material.icons.filled.Savings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.AgentReport
import com.dalab.internet.data.ReportCompanyPerformance
import com.dalab.internet.data.ReportTopCustomer
import com.dalab.internet.network.ApiClient
import com.dalab.internet.ui.theme.DalabDangerRed
import com.dalab.internet.ui.theme.DalabOutline
import com.dalab.internet.ui.theme.DalabSurfaceTint
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private data class ReportRange(val value: String, val label: String)

private val REPORT_RANGES = listOf(
    ReportRange("today", "Today"),
    ReportRange("yesterday", "Yesterday"),
    ReportRange("week", "Week"),
    ReportRange("1month", "1 Month"),
    ReportRange("3months", "3 Months"),
    ReportRange("6months", "6 Months"),
    ReportRange("1year", "1 Year"),
)

/** "My Reports" -- GET /agent/reports, scoped entirely to completed orders
 * this agent personally fulfilled. periodTotals/companies/topCustomers all
 * move together with [REPORT_RANGES]'s selected range; totals (the small
 * "All-time" line on the summary card) never does, per product decision --
 * see AgentReport's own doc comment. */
@Composable
fun ReportsScreen(onBack: () -> Unit) {
    var range by remember { mutableStateOf("today") }
    var report by remember { mutableStateOf<AgentReport?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun load() {
        loading = true
        scope.launch {
            try {
                val response = ApiClient.service.getReports(range)
                if (response.isSuccessful) {
                    report = response.body()
                    error = null
                } else {
                    error = "Couldn't load your report. Check your connection."
                }
            } catch (_: Exception) {
                error = "Couldn't load your report. Check your connection."
            }
            loading = false
        }
    }

    LaunchedEffect(range) { load() }

    Scaffold(containerColor = Color.White) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            ReportsHeader(onBack = onBack)

            Row(
                modifier = Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                REPORT_RANGES.forEach { r ->
                    RangePill(label = r.label, selected = range == r.value, onClick = { range = r.value })
                }
            }

            Spacer(Modifier.height(4.dp))

            if (error != null) {
                Text(
                    error!!,
                    color = DalabDangerRed,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                if (loading && report == null) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                } else {
                    val current = report
                    if (current == null) {
                        Text(
                            "No data yet.",
                            modifier = Modifier.align(Alignment.Center),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    } else {
                        ReportsContent(report = current)
                    }
                }
            }
        }
    }
}

@Composable
private fun ReportsHeader(onBack: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = DalabIndigo)
        }
        Column(modifier = Modifier.weight(1f)) {
            Text("My Reports", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = DalabIndigo)
            Text(
                "View your sales, orders and customer activity",
                style = MaterialTheme.typography.bodySmall,
                color = Color(0xFF6B7280),
            )
        }
        Surface(color = DalabSoftBlue.copy(alpha = 0.35f), shape = RoundedCornerShape(999.dp)) {
            Text(
                remember { SimpleDateFormat("MMM d, yyyy", Locale.US).format(Date()) },
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = DalabIndigo,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            )
        }
    }
}

@Composable
private fun RangePill(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        color = if (selected) DalabIndigo else Color.White,
        contentColor = if (selected) Color.White else DalabIndigo,
        shape = RoundedCornerShape(999.dp),
        border = if (selected) null else BorderStroke(1.dp, DalabOutline),
        modifier = Modifier.clickable(onClick = onClick),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp),
        )
    }
}

@Composable
private fun ReportsContent(report: AgentReport) {
    val hasPeriodData = report.periodTotals.totalOrders > 0

    LazyColumn(modifier = Modifier.fillMaxSize()) {
        item {
            SummaryRow(
                totalSales = report.periodTotals.totalSales,
                totalOrders = report.periodTotals.totalOrders,
                totalCustomers = report.periodTotals.totalCustomers,
                allTimeSales = report.totals.totalSales,
                allTimeOrders = report.totals.totalOrders,
            )
        }

        if (!hasPeriodData) {
            item {
                Surface(
                    color = DalabSurfaceTint,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                ) {
                    Text(
                        "No completed sales in this range.",
                        modifier = Modifier.padding(16.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = Color(0xFF6B7280),
                    )
                }
            }
        }

        item {
            SectionHeader(icon = Icons.Filled.BarChart, title = "Company Performance", subtitle = "Sales and orders by company")
        }
        item {
            Column(modifier = Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                // Lowest seller first, highest last -- a leaderboard read
                // top-to-bottom, #1 always at the bottom regardless of what
                // order the backend array happens to arrive in.
                report.companies.sortedByDescending { it.rank }.forEach { company ->
                    CompanyPerformanceRow(company)
                }
            }
        }

        item { Spacer(Modifier.height(22.dp)) }

        item {
            SectionHeader(icon = Icons.Filled.Groups, title = "Top 5 Customers", subtitle = "Customers with the most completed orders")
        }
        if (report.topCustomers.isEmpty()) {
            item {
                Text(
                    "No customer activity in this range.",
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFF6B7280),
                )
            }
        } else {
            item {
                Column(modifier = Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    report.topCustomers.forEach { customer ->
                        TopCustomerRow(customer)
                    }
                }
            }
        }

        item { Spacer(Modifier.height(24.dp)) }
    }
}

@Composable
private fun SummaryRow(
    totalSales: Double,
    totalOrders: Int,
    totalCustomers: Int,
    allTimeSales: Double,
    allTimeOrders: Int,
) {
    Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            SummaryCard(icon = Icons.Filled.Savings, iconColor = DalabGreen, value = "$${"%.2f".format(totalSales)}", label = "Total Sales", modifier = Modifier.weight(1f))
            SummaryCard(icon = Icons.Filled.Receipt, iconColor = DalabIndigo, value = "$totalOrders", label = "Total Orders", modifier = Modifier.weight(1f))
            SummaryCard(icon = Icons.Filled.Groups, iconColor = DalabIndigo, value = "$totalCustomers", label = "Customers", modifier = Modifier.weight(1f))
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "All-time: $${"%.2f".format(allTimeSales)} · $allTimeOrders orders",
            style = MaterialTheme.typography.labelSmall,
            color = Color(0xFF6B7280),
            modifier = Modifier.padding(start = 4.dp),
        )
    }
}

@Composable
private fun SummaryCard(icon: ImageVector, iconColor: Color, value: String, label: String, modifier: Modifier = Modifier) {
    Surface(
        color = Color.White,
        shape = RoundedCornerShape(16.dp),
        shadowElevation = 1.dp,
        modifier = modifier,
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Box(
                modifier = Modifier.size(34.dp).background(iconColor.copy(alpha = 0.12f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = iconColor, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.height(10.dp))
            Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = DalabIndigo)
            Text(label, style = MaterialTheme.typography.labelSmall, color = Color(0xFF6B7280))
        }
    }
}

@Composable
private fun SectionHeader(icon: ImageVector, title: String, subtitle: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(32.dp).background(DalabSoftBlue.copy(alpha = 0.4f), RoundedCornerShape(9.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = DalabIndigo, modifier = Modifier.size(17.dp))
        }
        Spacer(Modifier.width(10.dp))
        Column {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = DalabIndigo)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Color(0xFF6B7280))
        }
    }
}

// Rank 1 (the top performer) gets the solid brand-blue badge so it reads as
// "the one to notice" at a glance; every other rank gets the same neutral
// soft-blue tint the rest of this screen's accents use -- deliberately not
// gold/silver/bronze, per the "no unrelated brand colors" instruction.
@Composable
private fun RankBadge(rank: Int) {
    Surface(
        color = if (rank == 1) DalabIndigo else DalabSoftBlue.copy(alpha = 0.35f),
        contentColor = if (rank == 1) Color.White else DalabIndigo,
        shape = RoundedCornerShape(10.dp),
    ) {
        Text(
            "#$rank",
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        )
    }
}

@DrawableRes
private fun companyLogoRes(companyId: String): Int = logoResFor(companyId)

@Composable
private fun CompanyPerformanceRow(company: ReportCompanyPerformance) {
    val isTop = company.rank == 1
    Surface(
        color = if (isTop) DalabSoftBlue.copy(alpha = 0.18f) else Color.White,
        shape = RoundedCornerShape(14.dp),
        shadowElevation = if (isTop) 0.dp else 1.dp,
        border = if (isTop) BorderStroke(1.dp, DalabSoftBlue) else null,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RankBadge(company.rank)
            Spacer(Modifier.width(12.dp))
            Surface(color = Color.White, shape = RoundedCornerShape(8.dp), shadowElevation = 0.dp) {
                Image(
                    painter = painterResource(companyLogoRes(company.companyId)),
                    contentDescription = company.companyName,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.size(32.dp).padding(4.dp),
                )
            }
            Spacer(Modifier.width(10.dp))
            Text(company.companyName, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = DalabIndigo, modifier = Modifier.weight(1f))
            Column(horizontalAlignment = Alignment.End) {
                Text("$${"%.2f".format(company.totalSales)}", fontWeight = FontWeight.Bold, color = DalabGreen, style = MaterialTheme.typography.bodyLarge)
                Text("${company.totalOrders} orders", style = MaterialTheme.typography.labelSmall, color = Color(0xFF6B7280))
            }
        }
    }
}

@Composable
private fun TopCustomerRow(customer: ReportTopCustomer) {
    Surface(color = Color.White, shape = RoundedCornerShape(14.dp), shadowElevation = 1.dp, modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RankBadge(customer.rank)
            Spacer(Modifier.width(12.dp))
            Box(
                modifier = Modifier.size(34.dp).background(DalabSoftBlue.copy(alpha = 0.4f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Person, contentDescription = null, tint = DalabIndigo, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(customer.name ?: customer.phone, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = DalabIndigo)
                Text(customer.phone, style = MaterialTheme.typography.bodySmall, color = Color(0xFF6B7280))
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("${customer.completedOrders} orders", fontWeight = FontWeight.Bold, color = DalabIndigo, style = MaterialTheme.typography.bodyMedium)
                Text("$${"%.2f".format(customer.totalSpent)}", style = MaterialTheme.typography.labelSmall, color = Color(0xFF6B7280))
            }
        }
    }
}
