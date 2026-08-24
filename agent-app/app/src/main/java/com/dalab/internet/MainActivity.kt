package com.dalab.internet

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.data.ExchangeOrder
import com.dalab.internet.data.Order
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.diagnostics.HeartbeatStats
import com.dalab.internet.notifications.AgentAlertsState
import com.dalab.internet.notifications.PushTokenRegistrar
import com.dalab.internet.notifications.SupportDeepLink
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.service.AgentBackgroundService
import com.dalab.internet.sms.SmsInboxScanner
import com.dalab.internet.sms.SmsListenerState
import com.dalab.internet.ui.AlertsScreen
import com.dalab.internet.ui.AutoLoginScreen
import com.dalab.internet.ui.CustomersScreen
import com.dalab.internet.ui.DeviceSetupScreen
import com.dalab.internet.ui.DiagnosticsScreen
import com.dalab.internet.ui.ExchangeAccessibilitySetupScreen
import com.dalab.internet.ui.ExchangeOrderDetailScreen
import com.dalab.internet.ui.ResellerWithdrawalInteractiveAccessibilitySetupScreen
import com.dalab.internet.ui.ExchangeOrdersListScreen
import com.dalab.internet.ui.NewSaleScreen
import com.dalab.internet.ui.NotificationsScreen
import com.dalab.internet.ui.OrderDetailScreen
import com.dalab.internet.ui.OrdersListScreen
import com.dalab.internet.ui.PackagesScreen
import com.dalab.internet.ui.PermissionsStatusScreen
import com.dalab.internet.ui.ReliabilityDashboardScreen
import com.dalab.internet.ui.ReliabilitySetupScreen
import com.dalab.internet.ui.ReportsScreen
import com.dalab.internet.ui.SmsPermissionScreen
import com.dalab.internet.ui.SupportScreen
import com.dalab.internet.ui.TransactionHistoryScreen
import com.dalab.internet.ui.WalletDashboardScreen
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
        safely("agent_alerts_init") { AgentAlertsState.init(this) }
        safely("notification_channel_init") { createNotificationChannel() }
        safely("support_deep_link_init") { handleIntent(intent) }

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
            MaterialTheme {
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

    // Cold start: the notification tap itself launched this Activity, so the
    // extra is already on the very first Intent onCreate() sees.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // Warm start: android:launchMode="singleTop" (manifest) routes a
        // notification tap here instead of spawning a second instance, while
        // this Activity is already showing some other screen.
        safely("support_deep_link_new_intent") { handleIntent(intent) }
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_OPEN_SUPPORT, false) == true) {
            SupportDeepLink.pending = true
        }
    }

    companion object {
        const val EXTRA_OPEN_SUPPORT = "open_support"
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

private enum class Screen { PERMISSIONS, DEVICE_SETUP, AUTHENTICATING, RELIABILITY_SETUP, HOME, ORDER_DETAIL, PACKAGES, TRANSACTIONS, WALLET, DIAGNOSTICS, PERMISSIONS_STATUS, RELIABILITY_DASHBOARD, EXCHANGE_LIST, EXCHANGE_DETAIL, EXCHANGE_SETUP, NOTIFICATIONS, ALERTS, RESELLER_WITHDRAWAL_INTERACTIVE_SETUP, SUPPORT }
private enum class HomeTab { ORDERS, SALES, CUSTOMERS, REPORTS, MORE }

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
    val scope = rememberCoroutineScope()

    // A support-request push (support.routes.ts's notifyAssignedAgent()) was
    // tapped -- jump straight to the Support screen, which shows whichever
    // conversation is actually assigned to this agent (only ever one at a
    // time), no conversationId needed. Only fires once logged in and past
    // setup -- an agent who somehow taps a notification before finishing
    // device setup just lands wherever setup leaves them; the flag stays set
    // and is picked up the next time this effect re-runs.
    LaunchedEffect(SupportDeepLink.pending, screen) {
        if (SupportDeepLink.pending && (screen == Screen.HOME || screen == Screen.SUPPORT)) {
            SupportDeepLink.pending = false
            screen = Screen.SUPPORT
        }
    }

    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* Best-effort -- a denial just means no system-tray notification, the
          push itself still arrives and Support still shows the new
          conversation once opened. */ }

    // Registers this device's FCM token (and requests POST_NOTIFICATIONS on
    // Android 13+) once the agent actually reaches Home -- covers both a
    // fresh login and a resumed session, since a valid session skips
    // AutoLoginScreen entirely on every subsequent cold start.
    LaunchedEffect(screen == Screen.HOME) {
        if (screen == Screen.HOME) {
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            PushTokenRegistrar.registerIfNeeded(context)
        }
    }

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
            onOpenPackages = { screen = Screen.PACKAGES },
            onOpenTransactions = { screen = Screen.TRANSACTIONS },
            onOpenWallet = { screen = Screen.WALLET },
            onOpenDeviceSetup = { screen = Screen.DEVICE_SETUP },
            onOpenDiagnostics = { screen = Screen.DIAGNOSTICS },
            onOpenPermissionsStatus = { screen = Screen.PERMISSIONS_STATUS },
            onOpenReliabilityDashboard = { screen = Screen.RELIABILITY_DASHBOARD },
            onOpenMoneyExchange = { screen = Screen.EXCHANGE_LIST },
            onOpenNotifications = { screen = Screen.NOTIFICATIONS },
            onOpenAlerts = { screen = Screen.ALERTS },
            onOpenResellerWithdrawalSetup = { screen = Screen.RESELLER_WITHDRAWAL_INTERACTIVE_SETUP },
            onOpenSupport = { screen = Screen.SUPPORT },
        )

        Screen.ORDER_DETAIL -> selectedOrder?.let { order ->
            OrderDetailScreen(
                order = order,
                onBack = { screen = Screen.HOME },
                onOrderUpdated = { selectedOrder = it },
            )
        }

        Screen.PACKAGES -> PackagesScreen(onBack = { screen = Screen.HOME })

        Screen.TRANSACTIONS -> TransactionHistoryScreen(onBack = { screen = Screen.HOME })

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

        Screen.EXCHANGE_SETUP -> ExchangeAccessibilitySetupScreen(onBack = { screen = Screen.EXCHANGE_LIST })

        Screen.NOTIFICATIONS -> NotificationsScreen(onBack = { screen = Screen.HOME })

        Screen.ALERTS -> AlertsScreen(onBack = { screen = Screen.HOME })

        Screen.RESELLER_WITHDRAWAL_INTERACTIVE_SETUP -> ResellerWithdrawalInteractiveAccessibilitySetupScreen(onBack = { screen = Screen.HOME })

        Screen.SUPPORT -> SupportScreen(onBack = { screen = Screen.HOME })
    }
}

@Composable
private fun rememberLauncherForSmsPermissions(
    onResult: (Map<String, Boolean>) -> Unit
) = androidx.activity.compose.rememberLauncherForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions(), onResult
)

/** Bottom-nav shell for the logged-in agent: Orders, Sales, Customers, Reports, More. */
@Composable
private fun AgentHome(
    onOpenOrder: (Order) -> Unit,
    onOpenPackages: () -> Unit,
    onOpenTransactions: () -> Unit,
    onOpenWallet: () -> Unit,
    onOpenDeviceSetup: () -> Unit,
    onOpenDiagnostics: () -> Unit,
    onOpenPermissionsStatus: () -> Unit,
    onOpenReliabilityDashboard: () -> Unit,
    onOpenMoneyExchange: () -> Unit,
    onOpenNotifications: () -> Unit,
    onOpenAlerts: () -> Unit,
    onOpenResellerWithdrawalSetup: () -> Unit,
    onOpenSupport: () -> Unit,
) {
    var tab by remember { mutableStateOf(HomeTab.ORDERS) }

    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = tab == HomeTab.ORDERS,
                    onClick = { tab = HomeTab.ORDERS },
                    icon = { Icon(Icons.Filled.Home, contentDescription = "Home") },
                    label = { Text("Home") },
                )
                NavigationBarItem(
                    selected = tab == HomeTab.SALES,
                    onClick = { tab = HomeTab.SALES },
                    icon = { Icon(Icons.Filled.Sell, contentDescription = "New Sale") },
                    label = { Text("Sales") },
                )
                NavigationBarItem(
                    selected = tab == HomeTab.CUSTOMERS,
                    onClick = { tab = HomeTab.CUSTOMERS },
                    icon = { Icon(Icons.Filled.People, contentDescription = "Customers") },
                    label = { Text("Customers") },
                )
                NavigationBarItem(
                    selected = tab == HomeTab.REPORTS,
                    onClick = { tab = HomeTab.REPORTS },
                    icon = { Icon(Icons.Filled.Assessment, contentDescription = "Reports") },
                    label = { Text("Reports") },
                )
                NavigationBarItem(
                    selected = tab == HomeTab.MORE,
                    onClick = { tab = HomeTab.MORE },
                    icon = { Icon(Icons.Filled.MoreHoriz, contentDescription = "More") },
                    label = { Text("More") },
                )
            }
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            when (tab) {
                HomeTab.ORDERS -> OrdersListScreen(
                    onOpenOrder = onOpenOrder,
                    onOpenAlerts = onOpenAlerts,
                    onOpenWallet = onOpenWallet,
                    onOpenMoneyExchange = onOpenMoneyExchange,
                    onOpenSupport = onOpenSupport,
                )
                HomeTab.SALES -> NewSaleScreen()
                HomeTab.CUSTOMERS -> CustomersScreen()
                HomeTab.REPORTS -> ReportsScreen()
                HomeTab.MORE -> MoreScreen(
                    onOpenPackages = onOpenPackages,
                    onOpenTransactions = onOpenTransactions,
                    onOpenWallet = onOpenWallet,
                    onOpenDeviceSetup = onOpenDeviceSetup,
                    onOpenDiagnostics = onOpenDiagnostics,
                    onOpenPermissionsStatus = onOpenPermissionsStatus,
                    onOpenReliabilityDashboard = onOpenReliabilityDashboard,
                    onOpenMoneyExchange = onOpenMoneyExchange,
                    onOpenNotifications = onOpenNotifications,
                    onOpenResellerWithdrawalSetup = onOpenResellerWithdrawalSetup,
                    onOpenSupport = onOpenSupport,
                )
            }
        }
    }
}

/**
 * Grouped into categories instead of one long flat list, so an agent
 * scanning for something specific isn't reading past unrelated items —
 * Money first (what's checked most), then Catalog & Sales, Communication,
 * then Device & Diagnostics (setup/troubleshooting, checked least often).
 */
@Composable
private fun MoreScreen(
    onOpenPackages: () -> Unit,
    onOpenTransactions: () -> Unit,
    onOpenWallet: () -> Unit,
    onOpenDeviceSetup: () -> Unit,
    onOpenDiagnostics: () -> Unit,
    onOpenPermissionsStatus: () -> Unit,
    onOpenReliabilityDashboard: () -> Unit,
    onOpenMoneyExchange: () -> Unit,
    onOpenNotifications: () -> Unit,
    onOpenResellerWithdrawalSetup: () -> Unit,
    onOpenSupport: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        MoreSection(title = "Money") {
            MoreItem(
                title = "Wallet Balances",
                subtitle = "Provider balances and live payment transactions",
                icon = Icons.Filled.AccountBalanceWallet,
                onClick = onOpenWallet,
            )
            MoreItem(
                title = "Money Exchange",
                subtitle = "Verified exchanges waiting for payout",
                icon = Icons.Filled.CurrencyExchange,
                onClick = onOpenMoneyExchange,
            )
            MoreItem(
                title = "Reseller Withdraw Setup",
                subtitle = "Enable automated multi-step payouts (e.g. eDahab)",
                icon = Icons.Filled.AccountBalanceWallet,
                onClick = onOpenResellerWithdrawalSetup,
            )
        }
        MoreSection(title = "Catalog & Sales") {
            MoreItem(
                title = "Packages",
                subtitle = "Browse the full catalog and pricing",
                icon = Icons.Filled.List,
                onClick = onOpenPackages,
            )
            MoreItem(
                title = "Transaction History",
                subtitle = "Orders you've completed",
                icon = Icons.Filled.History,
                onClick = onOpenTransactions,
            )
        }
        MoreSection(title = "Communication") {
            MoreItem(
                title = "Agent Support",
                subtitle = "Chat with waiting customers — claim, reply, resolve",
                icon = Icons.Filled.SupportAgent,
                onClick = onOpenSupport,
            )
            MoreItem(
                title = "Customer Broadcast",
                subtitle = "Send a push notification to customers",
                icon = Icons.Filled.Notifications,
                onClick = onOpenNotifications,
            )
        }
        MoreSection(title = "Device & Diagnostics") {
            MoreItem(
                title = "Device",
                subtitle = DeviceIdentity.deviceName() ?: "Choose which registered device this phone is",
                icon = Icons.Filled.PhoneAndroid,
                onClick = onOpenDeviceSetup,
            )
            MoreItem(
                title = "Permissions",
                subtitle = "SMS + background service status for this device",
                icon = Icons.Filled.Security,
                onClick = onOpenPermissionsStatus,
            )
            MoreItem(
                title = "Reliability Dashboard",
                subtitle = "Foreground service, heartbeat, SMS reader, connectivity, and offline queue — live",
                icon = Icons.Filled.Speed,
                onClick = onOpenReliabilityDashboard,
            )
            MoreItem(
                title = "Diagnostics",
                subtitle = "Recent errors and automatic retries on this device",
                icon = Icons.Filled.BugReport,
                onClick = onOpenDiagnostics,
            )
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun MoreSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Text(
        title.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 16.dp, top = 20.dp, bottom = 4.dp),
    )
    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
        shape = RoundedCornerShape(14.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Column(content = content)
    }
}

@Composable
private fun MoreItem(title: String, subtitle: String, icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = { Text(subtitle) },
        leadingContent = { Icon(icon, contentDescription = null) },
        modifier = Modifier.clickable(onClick = onClick),
    )
}
