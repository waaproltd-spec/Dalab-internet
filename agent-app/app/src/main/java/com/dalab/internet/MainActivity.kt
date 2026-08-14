package com.dalab.internet

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.Assessment
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.CurrencyExchange
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Sell
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.data.ExchangeOrder
import com.dalab.internet.data.Order
import com.dalab.internet.data.SupportTicket
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.diagnostics.HeartbeatStats
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.service.AgentBackgroundService
import com.dalab.internet.sms.SmsInboxScanner
import com.dalab.internet.sms.SmsListenerState
import com.dalab.internet.ui.AutoLoginScreen
import com.dalab.internet.ui.CustomerSupportScreen
import com.dalab.internet.ui.CustomersScreen
import com.dalab.internet.ui.DeviceSetupScreen
import com.dalab.internet.ui.DiagnosticsScreen
import com.dalab.internet.ui.ExchangeAccessibilitySetupScreen
import com.dalab.internet.ui.ExchangeOrderDetailScreen
import com.dalab.internet.ui.ExchangeOrdersListScreen
import com.dalab.internet.ui.NewSaleScreen
import com.dalab.internet.ui.OrderDetailScreen
import com.dalab.internet.ui.OrdersListScreen
import com.dalab.internet.ui.PackagesScreen
import com.dalab.internet.ui.PermissionsStatusScreen
import com.dalab.internet.ui.ReliabilityDashboardScreen
import com.dalab.internet.ui.ReliabilitySetupScreen
import com.dalab.internet.ui.ReportsScreen
import com.dalab.internet.ui.SendNotificationScreen
import com.dalab.internet.ui.SmsPermissionScreen
import com.dalab.internet.ui.SupportTicketChatScreen
import com.dalab.internet.ui.TransactionHistoryScreen
import com.dalab.internet.ui.WalletDashboardScreen
import com.dalab.internet.ui.components.DalabBottomBar
import com.dalab.internet.ui.components.DalabBottomBarItem
import com.dalab.internet.ui.theme.DalabEyebrowStyle
import com.dalab.internet.ui.theme.DalabTheme
import kotlinx.coroutines.launch

private val SMS_PERMISSIONS = arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS)

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // DalabAgentApp.onCreate() already ran all of these once, each isolated
        // in its own try/catch — these are defensive, idempotent no-ops in the
        // normal case, but still guarded individually here too so a lingering
        // failure in one can't prevent the screen from ever rendering.
        safely("session_init") { SessionManager.init(this) }
        safely("device_identity_init") { DeviceIdentity.init(this) }
        safely("sms_listener_init") { SmsListenerState.init(this) }
        safely("pending_queue_init") { PendingActionQueue.init(this) }
        safely("diagnostics_init") { DiagnosticsLog.init(this) }
        safely("heartbeat_stats_init") { HeartbeatStats.init(this) }
        safely("notification_channel_init") { createNotificationChannel() }

        val loggedIn = try { SessionManager.isLoggedIn() } catch (e: Exception) {
            DiagnosticsLog.record("session_check", "isLoggedIn() failed: ${e.message}"); false
        }
        val deviceSet = try { DeviceIdentity.isSet() } catch (e: Exception) {
            DiagnosticsLog.record("device_check", "isSet() failed: ${e.message}"); false
        }
        if (loggedIn && deviceSet) {
            safely("background_service_start") { AgentBackgroundService.start(this) }
        }

        setContent {
            DalabTheme {
                AgentApp()
            }
        }
    }

    private inline fun safely(tag: String, block: () -> Unit) {
        try {
            block()
        } catch (e: Exception) {
            DiagnosticsLog.record(tag, "Failed: ${e.stackTraceToString().take(2000)}")
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                "payment_channel", "Payment detections", NotificationManager.IMPORTANCE_HIGH
            ).apply {
                // The one alert channel worth vibrating for — a payment/order
                // update the agent needs to notice even with the phone in a
                // pocket. The silent background-monitoring notification
                // (AgentBackgroundService's own channel) deliberately does not.
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 250, 150, 250)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
}

// TRANSACTIONS and SUPPORT_LIST no longer exist as separate drill-ins:
// Recent Activity and Support are now top-level bottom-nav tabs (see
// HomeTab below) that render their screens directly, the same way the
// former ORDERS tab always has. SALES/CUSTOMERS/REPORTS are new drill-ins
// from More, replacing their old top-level tab slots (see "Home screen
// cleanup" — the functionality is unchanged, just no longer front-and-center).
private enum class Screen { PERMISSIONS, DEVICE_SETUP, AUTHENTICATING, RELIABILITY_SETUP, HOME, ORDER_DETAIL, PACKAGES, WALLET, DIAGNOSTICS, PERMISSIONS_STATUS, RELIABILITY_DASHBOARD, EXCHANGE_LIST, EXCHANGE_DETAIL, EXCHANGE_SETUP, SUPPORT_CHAT, SALES, CUSTOMERS, REPORTS }
private enum class HomeTab { HOME, NOTIFICATIONS, SUPPORT, RECENT_ACTIVITY, MORE }

@Composable
private fun AgentApp() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val activity = context as ComponentActivity

    fun smsGranted() = SMS_PERMISSIONS.all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }

    // Battery-optimization exemption is the #1 real-world cause of stale
    // heartbeats / SMS monitoring silently stopping — this is checked once
    // per cold start (not on every recomposition) so ReliabilitySetupScreen
    // is shown once per app launch until it's actually granted.
    fun batteryUnrestricted(): Boolean {
        val powerManager = context.getSystemService(PowerManager::class.java) ?: return true
        return powerManager.isIgnoringBatteryOptimizations(context.packageName)
    }

    // There is no login screen: once a device is chosen, the app authenticates
    // itself against whichever agent is assigned to it (see AutoLoginScreen).
    // A session normally outlives the app (it's only ever cleared by an
    // explicit backend revocation), so on every subsequent open this resolves
    // straight to HOME (or RELIABILITY_SETUP first, if still unexempted) with
    // no network round-trip at all.
    fun nextScreen() = when {
        !DeviceIdentity.isSet() -> Screen.DEVICE_SETUP
        !SessionManager.isLoggedIn() -> Screen.AUTHENTICATING
        !batteryUnrestricted() -> Screen.RELIABILITY_SETUP
        else -> Screen.HOME
    }

    var hasSmsPermission by remember { mutableStateOf(smsGranted()) }
    var permanentlyDenied by remember { mutableStateOf(false) }
    var screen by remember {
        mutableStateOf(
            if (!hasSmsPermission) Screen.PERMISSIONS
            else nextScreen()
        )
    }
    var selectedOrder by remember { mutableStateOf<Order?>(null) }
    var selectedExchangeOrder by remember { mutableStateOf<ExchangeOrder?>(null) }
    var selectedSupportTicket by remember { mutableStateOf<SupportTicket?>(null) }
    val scope = rememberCoroutineScope()

    // Granting READ_SMS/RECEIVE_SMS previously only enabled the live receiver
    // for messages from that moment forward — READ_SMS itself was requested
    // but never actually used. This catches up on any payment SMS already
    // sitting in the inbox the moment permission is granted (bounded lookback,
    // see SmsInboxScanner), and also covers the case where permission was
    // already granted in a previous session/app version before this existed.
    LaunchedEffect(Unit) {
        if (smsGranted()) {
            SmsInboxScanner.scanRecentInboxOnce(context)
        }
    }

    val permissionLauncher = rememberLauncherForSmsPermissions(
        onResult = { grantedMap ->
            hasSmsPermission = grantedMap.values.all { it }
            if (hasSmsPermission) {
                SmsListenerState.setListening(true)
                scope.launch { SmsInboxScanner.scanRecentInboxOnce(context) }
                screen = nextScreen()
            } else {
                // If the user denied without checking "don't ask again", Android will
                // still show the rationale next time; shouldShowRequestPermissionRationale
                // returns false only once truly "permanently" denied.
                permanentlyDenied = SMS_PERMISSIONS.none {
                    activity.shouldShowRequestPermissionRationale(it)
                }
            }
        }
    )

    when (screen) {
        Screen.PERMISSIONS -> SmsPermissionScreen(
            permanentlyDenied = permanentlyDenied,
            onRequestPermissions = { permissionLauncher.launch(SMS_PERMISSIONS) },
        )

        Screen.DEVICE_SETUP -> DeviceSetupScreen(
            onDeviceSelected = { screen = Screen.AUTHENTICATING },
        )

        Screen.AUTHENTICATING -> AutoLoginScreen(
            onSuccess = {
                AgentBackgroundService.start(context)
                screen = if (batteryUnrestricted()) Screen.HOME else Screen.RELIABILITY_SETUP
            },
            onChooseDifferentDevice = { screen = Screen.DEVICE_SETUP },
        )

        Screen.RELIABILITY_SETUP -> ReliabilitySetupScreen(onContinue = { screen = Screen.HOME })

        Screen.HOME -> AgentHome(
            onOpenOrder = { order -> selectedOrder = order; screen = Screen.ORDER_DETAIL },
            onOpenSupportTicket = { ticket -> selectedSupportTicket = ticket; screen = Screen.SUPPORT_CHAT },
            onOpenPackages = { screen = Screen.PACKAGES },
            onOpenWallet = { screen = Screen.WALLET },
            onOpenDeviceSetup = { screen = Screen.DEVICE_SETUP },
            onOpenDiagnostics = { screen = Screen.DIAGNOSTICS },
            onOpenPermissionsStatus = { screen = Screen.PERMISSIONS_STATUS },
            onOpenReliabilityDashboard = { screen = Screen.RELIABILITY_DASHBOARD },
            onOpenMoneyExchange = { screen = Screen.EXCHANGE_LIST },
            onOpenSales = { screen = Screen.SALES },
            onOpenCustomers = { screen = Screen.CUSTOMERS },
            onOpenReports = { screen = Screen.REPORTS },
        )

        Screen.ORDER_DETAIL -> selectedOrder?.let { order ->
            OrderDetailScreen(
                order = order,
                onBack = { screen = Screen.HOME },
                onOrderUpdated = { selectedOrder = it },
            )
        }

        Screen.PACKAGES -> PackagesScreen(onBack = { screen = Screen.HOME })

        Screen.WALLET -> WalletDashboardScreen(onBack = { screen = Screen.HOME })

        Screen.DIAGNOSTICS -> DiagnosticsScreen(onBack = { screen = Screen.HOME })

        Screen.PERMISSIONS_STATUS -> PermissionsStatusScreen(onBack = { screen = Screen.HOME })

        Screen.RELIABILITY_DASHBOARD -> ReliabilityDashboardScreen(onBack = { screen = Screen.HOME })

        Screen.EXCHANGE_LIST -> ExchangeOrdersListScreen(
            onOpenOrder = { order -> selectedExchangeOrder = order; screen = Screen.EXCHANGE_DETAIL },
            onOpenSetup = { screen = Screen.EXCHANGE_SETUP },
            onBack = { screen = Screen.HOME },
        )

        Screen.EXCHANGE_DETAIL -> selectedExchangeOrder?.let { order ->
            ExchangeOrderDetailScreen(
                order = order,
                onBack = { screen = Screen.EXCHANGE_LIST },
                onOrderUpdated = { selectedExchangeOrder = it },
            )
        }

        Screen.SUPPORT_CHAT -> selectedSupportTicket?.let { ticket ->
            SupportTicketChatScreen(
                initialTicket = ticket,
                onBack = { screen = Screen.HOME },
            )
        }

        Screen.EXCHANGE_SETUP -> ExchangeAccessibilitySetupScreen(onBack = { screen = Screen.EXCHANGE_LIST })

        Screen.SALES -> NewSaleScreen(onBack = { screen = Screen.HOME })

        Screen.CUSTOMERS -> CustomersScreen(onBack = { screen = Screen.HOME })

        Screen.REPORTS -> ReportsScreen(onBack = { screen = Screen.HOME })
    }
}

@Composable
private fun rememberLauncherForSmsPermissions(
    onResult: (Map<String, Boolean>) -> Unit
) = androidx.activity.compose.rememberLauncherForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions(), onResult
)

/** Bottom-nav shell for the logged-in agent: Home, Notifications, Support, Recent Activity, More. */
@Composable
private fun AgentHome(
    onOpenOrder: (Order) -> Unit,
    onOpenSupportTicket: (SupportTicket) -> Unit,
    onOpenPackages: () -> Unit,
    onOpenWallet: () -> Unit,
    onOpenDeviceSetup: () -> Unit,
    onOpenDiagnostics: () -> Unit,
    onOpenPermissionsStatus: () -> Unit,
    onOpenReliabilityDashboard: () -> Unit,
    onOpenMoneyExchange: () -> Unit,
    onOpenSales: () -> Unit,
    onOpenCustomers: () -> Unit,
    onOpenReports: () -> Unit,
) {
    var tab by remember { mutableStateOf(HomeTab.HOME) }
    val tabValues = remember { HomeTab.values().toList() }
    val tabItems = remember {
        listOf(
            DalabBottomBarItem(Icons.Filled.Home, "Home"),
            DalabBottomBarItem(Icons.Filled.Notifications, "Notifications"),
            DalabBottomBarItem(Icons.Filled.SupportAgent, "Support"),
            DalabBottomBarItem(Icons.Filled.History, "Recent Activity"),
            DalabBottomBarItem(Icons.Filled.MoreHoriz, "More"),
        )
    }

    Scaffold(
        bottomBar = {
            DalabBottomBar(
                items = tabItems,
                selectedIndex = tabValues.indexOf(tab),
                onSelect = { index -> tab = tabValues[index] },
            )
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            when (tab) {
                HomeTab.HOME -> OrdersListScreen(onOpenOrder = onOpenOrder)
                // No onBack -- this is a top-level tab now, not a drill-in
                // from More, so it has no back target (same as every other
                // tab here). Everything about how the queue itself works
                // (real-time refresh, accept flow, ticket data) is untouched.
                HomeTab.NOTIFICATIONS -> SendNotificationScreen()
                HomeTab.SUPPORT -> CustomerSupportScreen(onOpenTicket = onOpenSupportTicket)
                HomeTab.RECENT_ACTIVITY -> TransactionHistoryScreen()
                HomeTab.MORE -> MoreScreen(
                    onOpenPackages = onOpenPackages,
                    onOpenWallet = onOpenWallet,
                    onOpenDeviceSetup = onOpenDeviceSetup,
                    onOpenDiagnostics = onOpenDiagnostics,
                    onOpenPermissionsStatus = onOpenPermissionsStatus,
                    onOpenReliabilityDashboard = onOpenReliabilityDashboard,
                    onOpenMoneyExchange = onOpenMoneyExchange,
                    onOpenSales = onOpenSales,
                    onOpenCustomers = onOpenCustomers,
                    onOpenReports = onOpenReports,
                )
            }
        }
    }
}

private data class MoreMenuItem(val icon: ImageVector, val title: String, val subtitle: String, val onClick: () -> Unit)

/**
 * Everything that isn't Home/Support/Recent Activity now lives here,
 * including Sales/Customers/Reports (moved off the top-level bottom nav —
 * see "Home screen cleanup" — but still fully reachable, nothing was
 * deleted). One rounded card grouping every destination, rather than a
 * bare full-bleed list, for a calmer, more deliberate "settings menu" feel.
 */
@Composable
private fun MoreScreen(
    onOpenPackages: () -> Unit,
    onOpenWallet: () -> Unit,
    onOpenDeviceSetup: () -> Unit,
    onOpenDiagnostics: () -> Unit,
    onOpenPermissionsStatus: () -> Unit,
    onOpenReliabilityDashboard: () -> Unit,
    onOpenMoneyExchange: () -> Unit,
    onOpenSales: () -> Unit,
    onOpenCustomers: () -> Unit,
    onOpenReports: () -> Unit,
) {
    val items = listOf(
        MoreMenuItem(Icons.Filled.CurrencyExchange, "Money Exchange", "Verified exchanges waiting for payout", onOpenMoneyExchange),
        MoreMenuItem(Icons.Filled.AccountBalanceWallet, "Wallet Balances", "Provider balances and live payment transactions", onOpenWallet),
        MoreMenuItem(Icons.Filled.List, "Packages", "Browse the full catalog and pricing", onOpenPackages),
        MoreMenuItem(Icons.Filled.Sell, "Sales", "Create a walk-in sale for a customer", onOpenSales),
        MoreMenuItem(Icons.Filled.People, "Customers", "Search and add customers", onOpenCustomers),
        MoreMenuItem(Icons.Filled.Assessment, "Reports", "Your completed-sales summary", onOpenReports),
        MoreMenuItem(Icons.Filled.PhoneAndroid, "Device", DeviceIdentity.deviceName() ?: "Choose which registered device this phone is", onOpenDeviceSetup),
        MoreMenuItem(Icons.Filled.BugReport, "Diagnostics", "Recent errors and automatic retries on this device", onOpenDiagnostics),
        MoreMenuItem(Icons.Filled.Security, "Permissions", "SMS + background service status for this device", onOpenPermissionsStatus),
        MoreMenuItem(Icons.Filled.Speed, "Reliability Dashboard", "Foreground service, heartbeat, SMS reader, connectivity, and offline queue — live", onOpenReliabilityDashboard),
    )

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Text(
            "MORE",
            style = DalabEyebrowStyle,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 20.dp, top = 20.dp, bottom = 8.dp),
        )
        Card(
            modifier = Modifier.padding(horizontal = 16.dp),
            shape = RoundedCornerShape(18.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        ) {
            Column {
                items.forEachIndexed { index, item ->
                    ListItem(
                        headlineContent = { Text(item.title, fontWeight = FontWeight.SemiBold) },
                        supportingContent = { Text(item.subtitle, style = MaterialTheme.typography.bodySmall) },
                        leadingContent = {
                            Box(
                                modifier = Modifier
                                    .size(38.dp)
                                    .background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(12.dp)),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(item.icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                            }
                        },
                        colors = ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
                        modifier = Modifier.clickable(onClick = item.onClick),
                    )
                    if (index != items.lastIndex) Divider(modifier = Modifier.padding(start = 70.dp))
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}
