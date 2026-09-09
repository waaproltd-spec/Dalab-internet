package com.dalab.internet.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Apartment
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.VipNumberAgentOrder
import com.dalab.internet.data.VipPackageAgentOrder
import com.dalab.internet.network.ApiClient
import com.dalab.internet.util.formatApiDateTime
import kotlinx.coroutines.launch

/**
 * VIP Number and VIP Number Package order detail — the one place an agent
 * can actually complete a real, paid VIP order. Both screens share the
 * exact list-detail-POST pattern OrderDetailScreen.kt already established
 * (current/working/message state triad, POST-then-refresh-current-from-
 * response, onOrderUpdated pushes the fresh object back up to MainActivity's
 * lifted state) — kept in one file since the two orders are structurally
 * the same thing (one or several VIP numbers + one total price) and a
 * second copy of that pattern would just be noise.
 *
 * The workflow is Verify Payment -> Create -> Complete: Verify Payment is
 * implicit (isPaid, set by Admin/automatic payment confirmation, before an
 * order ever reaches an agent), Create (POST .../start) marks that the
 * agent has begun the real-world work, and Complete (POST .../complete)
 * marks it finished. Both POST routes re-check payment/started/terminal
 * state on the server independently of what the UI shows, so this is real
 * enforcement, not just button-hiding — see VipWorkflowSection below.
 */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VipNumberAgentOrderDetailScreen(
    order: VipNumberAgentOrder,
    onBack: () -> Unit,
    onOrderUpdated: (VipNumberAgentOrder) -> Unit,
) {
    var current by remember(order) { mutableStateOf(order) }
    var working by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun startOrder() {
        working = true
        message = null
        scope.launch {
            try {
                val response = ApiClient.service.startAgentVipNumberOrder(current.id)
                response.body()?.let {
                    current = it
                    onOrderUpdated(it)
                } ?: run {
                    message = if (response.code() == 409) {
                        "Can't start yet — payment isn't verified, or this was already started."
                    } else {
                        "Couldn't start — try again."
                    }
                }
            } catch (_: Exception) {
                message = "Network error while starting."
            }
            working = false
        }
    }

    fun completeOrder() {
        working = true
        message = null
        scope.launch {
            try {
                val response = ApiClient.service.completeAgentVipNumberOrder(current.id)
                response.body()?.let {
                    current = it
                    onOrderUpdated(it)
                    message = "Order marked as completed."
                } ?: run {
                    message = if (response.code() == 409) {
                        "This order can't be completed — it isn't paid, hasn't been started, or is already actioned."
                    } else {
                        "Couldn't complete — try again."
                    }
                }
            } catch (_: Exception) {
                message = "Network error while completing."
            }
            working = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("VIP Number Order") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(20.dp)
                .fillMaxSize(),
        ) {
            VipOrderHeaderCard(
                number = current.phoneNumber ?: "—",
                company = current.companyName ?: "—",
            )

            Spacer(Modifier.height(16.dp))
            VipCustomerInfoCard(
                fullName = current.customerFullName ?: current.customerName ?: "Not provided",
                motherName = current.motherName ?: "Not provided",
                location = current.location ?: "Not provided",
                district = current.district ?: "Not provided",
            )

            Spacer(Modifier.height(16.dp))
            VipPaymentCard(paidFrom = current.senderPhone ?: "Not provided")

            Spacer(Modifier.height(20.dp))
            VipWorkflowSection(
                message = message,
                isTerminal = current.isTerminal,
                isPaid = current.isPaid,
                isStarted = current.isStarted,
                status = current.status,
                working = working,
                onStart = ::startOrder,
                onComplete = ::completeOrder,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VipPackageAgentOrderDetailScreen(
    order: VipPackageAgentOrder,
    onBack: () -> Unit,
    onOrderUpdated: (VipPackageAgentOrder) -> Unit,
) {
    var current by remember(order) { mutableStateOf(order) }
    var working by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun startOrder() {
        working = true
        message = null
        scope.launch {
            try {
                val response = ApiClient.service.startAgentVipPackageOrder(current.id)
                response.body()?.let {
                    current = it
                    onOrderUpdated(it)
                } ?: run {
                    message = if (response.code() == 409) {
                        "Can't start yet — payment isn't verified, or this was already started."
                    } else {
                        "Couldn't start — try again."
                    }
                }
            } catch (_: Exception) {
                message = "Network error while starting."
            }
            working = false
        }
    }

    fun completeOrder() {
        working = true
        message = null
        scope.launch {
            try {
                val response = ApiClient.service.completeAgentVipPackageOrder(current.id)
                response.body()?.let {
                    current = it
                    onOrderUpdated(it)
                    message = "Order marked as completed."
                } ?: run {
                    message = if (response.code() == 409) {
                        "This order can't be completed — it isn't paid, hasn't been started, or is already actioned."
                    } else {
                        "Couldn't complete — try again."
                    }
                }
            } catch (_: Exception) {
                message = "Network error while completing."
            }
            working = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("VIP Package Order") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(20.dp)
                .fillMaxSize(),
        ) {
            VipPackageHeaderCard(
                size = current.size ?: current.items?.size ?: 0,
                items = current.items.orEmpty(),
            )

            Spacer(Modifier.height(16.dp))
            VipCustomerInfoCard(
                fullName = current.customerFullName ?: current.customerName ?: "Not provided",
                motherName = current.motherName ?: "Not provided",
                location = current.location ?: "Not provided",
                district = current.district ?: "Not provided",
                phone = current.customerPhone ?: "Not provided",
            )

            Spacer(Modifier.height(16.dp))
            VipOrderStatusCard(dateText = formatApiDateTime(current.createdAt))

            Spacer(Modifier.height(20.dp))
            VipWorkflowSection(
                message = message,
                isTerminal = current.isTerminal,
                isPaid = current.isPaid,
                isStarted = current.isStarted,
                status = current.status,
                working = working,
                onStart = ::startOrder,
                onComplete = ::completeOrder,
            )
        }
    }
}

/** Light tinted card at the top: the VIP number itself and who it's registered to. */
@Composable
private fun VipOrderHeaderCard(number: String, company: String) {
    Surface(
        color = DalabSoftBlue.copy(alpha = 0.35f),
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier.size(48.dp).clip(CircleShape).background(DalabIndigo),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Phone, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(14.dp))
            Column {
                Text("Number to Buy", style = MaterialTheme.typography.labelSmall, color = Color.Gray)
                Text(number, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleLarge, color = DalabIndigo)
                Spacer(Modifier.height(6.dp))
                Text("Company", style = MaterialTheme.typography.labelSmall, color = Color.Gray)
                Text(company, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleLarge, color = DalabIndigo)
            }
        }
    }
}

/** Same tinted header treatment as [VipOrderHeaderCard], but for the whole package of numbers. */
@Composable
private fun VipPackageHeaderCard(size: Int, items: List<com.dalab.internet.data.VipPackageAgentOrderItem>) {
    Surface(
        color = DalabSoftBlue.copy(alpha = 0.35f),
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp).fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier.size(48.dp).clip(CircleShape).background(DalabIndigo),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.ConfirmationNumber, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp))
                }
                Spacer(Modifier.width(14.dp))
                Text(
                    "${if (size > 0) size else items.size} Numbers Package",
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.titleMedium,
                    color = DalabIndigo,
                )
            }
            if (items.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Surface(color = Color.White, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(horizontal = 14.dp)) {
                        items.forEachIndexed { index, item ->
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(item.phoneNumber ?: "—", fontWeight = FontWeight.Medium)
                                Text(
                                    listOfNotNull(item.companyName, item.category?.replaceFirstChar { it.uppercase() }).joinToString(" · "),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = Color.Gray,
                                )
                            }
                            if (index != items.lastIndex) HorizontalDivider(color = Color(0xFFF0F0F0))
                        }
                    }
                }
            }
        }
    }
}

/**
 * Dark brand-color card: centered avatar, then a white sub-card of
 * icon-prefixed customer fields -- Full Name, Mother's Name, Location,
 * District. [phone] is optional: VIP Number Order's own spec says Customer
 * Info shows only those four fields (payment phone gets its own separate
 * Payment section, see [VipPaymentCard]), while the Package screen still
 * shows the customer's phone inline here.
 */
@Composable
private fun VipCustomerInfoCard(fullName: String, motherName: String, location: String, district: String, phone: String? = null) {
    Surface(
        color = DalabIndigo,
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(20.dp).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                modifier = Modifier.size(64.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.15f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Person, contentDescription = null, tint = Color.White, modifier = Modifier.size(32.dp))
            }
            Spacer(Modifier.height(10.dp))
            Text("Customer Info", color = Color.White, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(16.dp))
            Surface(color = Color.White, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(horizontal = 16.dp)) {
                    IconDetailRow(Icons.Filled.Person, "Full Name", fullName)
                    IconDetailRow(Icons.Filled.Groups, "Mother's Name", motherName)
                    IconDetailRow(Icons.Filled.Place, "Location", location)
                    IconDetailRow(Icons.Filled.Apartment, "District", district, showDivider = phone != null)
                    if (phone != null) {
                        IconDetailRow(Icons.Filled.Phone, "Phone number you'll pay from", phone, showDivider = false)
                    }
                }
            }
        }
    }
}

/** One icon-badged label/value row inside the white customer-info sub-card. */
@Composable
private fun IconDetailRow(icon: ImageVector, label: String, value: String, showDivider: Boolean = true) {
    Column {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier.size(32.dp).clip(RoundedCornerShape(8.dp)).background(DalabSoftBlue.copy(alpha = 0.35f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = DalabIndigo, modifier = Modifier.size(16.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column {
                Text(label, style = MaterialTheme.typography.labelSmall, color = Color.Gray)
                Text(value, fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (showDivider) HorizontalDivider(color = Color(0xFFF0F0F0))
    }
}

/** Light bordered card: the single number the agent verifies payment was made from. */
@Composable
private fun VipPaymentCard(paidFrom: String) {
    Surface(
        color = Color(0xFFF7FAFC),
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, Color(0xFFE5EEF2)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier.size(36.dp).clip(CircleShape).background(DalabSoftBlue.copy(alpha = 0.35f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Phone, contentDescription = null, tint = DalabIndigo, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column {
                Text("Paid From", style = MaterialTheme.typography.labelSmall, color = Color.Gray)
                Text(paidFrom, fontWeight = FontWeight.Bold)
            }
        }
    }
}

/** Light bordered card: a clock-prefixed order timestamp. */
@Composable
private fun VipOrderStatusCard(dateText: String) {
    Surface(
        color = Color(0xFFF7FAFC),
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, Color(0xFFE5EEF2)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier.size(36.dp).clip(CircleShape).background(DalabSoftBlue.copy(alpha = 0.35f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Schedule, contentDescription = null, tint = DalabIndigo, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column {
                Text("Orders status time", style = MaterialTheme.typography.labelSmall, color = Color.Gray)
                Text(dateText, fontWeight = FontWeight.Bold)
            }
        }
    }
}

/**
 * Status message plus the current step of the Verify Payment -> Create ->
 * Complete workflow. Verify Payment isn't its own button -- isPaid is the
 * server's own payment-verification signal (see agent_started_at's own
 * migration comment), so once paid the agent sees Create; once Create has
 * run (isStarted) the agent sees Complete. Both onStart and onComplete hit
 * real backend routes that independently re-check the same order this
 * enables the button for, so this is enforcement, not just button-hiding.
 */
@Composable
private fun VipWorkflowSection(
    message: String?,
    isTerminal: Boolean,
    isPaid: Boolean,
    isStarted: Boolean,
    status: String?,
    working: Boolean,
    onStart: () -> Unit,
    onComplete: () -> Unit,
) {
    if (message != null) {
        Text(message, color = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(12.dp))
    }

    when {
        isTerminal -> Text(
            "This order is $status and can't be changed further.",
            style = MaterialTheme.typography.bodyMedium,
        )
        !isPaid -> Text(
            "This order hasn't been paid yet — Create unlocks once payment is verified.",
            style = MaterialTheme.typography.labelSmall,
        )
        !isStarted -> Button(
            onClick = onStart,
            enabled = !working,
            shape = RoundedCornerShape(50),
            colors = ButtonDefaults.buttonColors(containerColor = DalabIndigo),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Text(if (working) "Starting..." else "Create", fontWeight = FontWeight.Bold)
        }
        else -> Button(
            onClick = onComplete,
            enabled = !working,
            shape = RoundedCornerShape(50),
            colors = ButtonDefaults.buttonColors(containerColor = DalabIndigo),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Text(if (working) "Completing..." else "Complete", fontWeight = FontWeight.Bold)
        }
    }
}
