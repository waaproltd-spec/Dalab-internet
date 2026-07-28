package com.dalab.internet

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assessment
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Sell
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import com.dalab.internet.auth.AuthRepository
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.data.Order
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.service.AgentBackgroundService
import com.dalab.internet.sms.SmsInboxScanner
import com.dalab.internet.sms.SmsListenerState
import com.dalab.internet.ui.CustomersScreen
import com.dalab.internet.ui.DeviceSetupScreen
import com.dalab.internet.ui.DiagnosticsScreen
import com.dalab.internet.ui.LoginScreen
import com.dalab.internet.ui.NewSaleScreen
import com.dalab.internet.ui.OrderDetailScreen
import com.dalab.internet.ui.OrdersListScreen
import com.dalab.internet.ui.PackagesScreen
import com.dalab.internet.ui.PermissionsStatusScreen
import com.dalab.internet.ui.ReportsScreen
import com.dalab.internet.ui.SmsPermissionScreen
import com.dalab.internet.ui.TransactionHistoryScreen
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

private enum class Screen { PERMISSIONS, LOGIN, DEVICE_SETUP, HOME, ORDER_DETAIL, PACKAGES, TRANSACTIONS, DIAGNOSTICS, PERMISSIONS_STATUS }
private enum class HomeTab { ORDERS, SALES, CUSTOMERS, REPORTS, MORE }

@Composable
private fun AgentApp() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val activity = context as ComponentActivity

    fun smsGranted() = SMS_PERMISSIONS.all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }

    fun homeOrDeviceSetup() = if (DeviceIdentity.isSet()) Screen.HOME else Screen.DEVICE_SETUP

    var hasSmsPermission by remember { mutableStateOf(smsGranted()) }
    var permanentlyDenied by remember { mutableStateOf(false) }
    var screen by remember {
        mutableStateOf(
            if (!hasSmsPermission) Screen.PERMISSIONS
            else if (!SessionManager.isLoggedIn()) Screen.LOGIN
            else homeOrDeviceSetup()
        )
    }
    var selectedOrder by remember { mutableStateOf<Order?>(null) }
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
                screen = if (SessionManager.isLoggedIn()) homeOrDeviceSetup() else Screen.LOGIN
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

        Screen.LOGIN -> LoginScreen(onLoggedIn = { screen = homeOrDeviceSetup() })

        Screen.DEVICE_SETUP -> DeviceSetupScreen(
            onDeviceSelected = {
                AgentBackgroundService.start(context)
                screen = Screen.HOME
            },
        )

        Screen.HOME -> AgentHome(
            onOpenOrder = { order -> selectedOrder = order; screen = Screen.ORDER_DETAIL },
            onOpenPackages = { screen = Screen.PACKAGES },
            onOpenTransactions = { screen = Screen.TRANSACTIONS },
            onOpenDeviceSetup = { screen = Screen.DEVICE_SETUP },
            onOpenDiagnostics = { screen = Screen.DIAGNOSTICS },
            onOpenPermissionsStatus = { screen = Screen.PERMISSIONS_STATUS },
            onLogout = {
                AuthRepository.logout()
                AgentBackgroundService.stop(context)
                screen = Screen.LOGIN
            },
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

        Screen.DIAGNOSTICS -> DiagnosticsScreen(onBack = { screen = Screen.HOME })

        Screen.PERMISSIONS_STATUS -> PermissionsStatusScreen(onBack = { screen = Screen.HOME })
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
    onOpenDeviceSetup: () -> Unit,
    onOpenDiagnostics: () -> Unit,
    onOpenPermissionsStatus: () -> Unit,
    onLogout: () -> Unit,
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
                    icon = { Icon(Icons.Filled.PointOfSale, contentDescription = "More") },
                    label = { Text("More") },
                )
            }
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            when (tab) {
                HomeTab.ORDERS -> OrdersListScreen(onOpenOrder = onOpenOrder)
                HomeTab.SALES -> NewSaleScreen()
                HomeTab.CUSTOMERS -> CustomersScreen()
                HomeTab.REPORTS -> ReportsScreen()
                HomeTab.MORE -> MoreScreen(
                    onOpenPackages = onOpenPackages,
                    onOpenTransactions = onOpenTransactions,
                    onOpenDeviceSetup = onOpenDeviceSetup,
                    onOpenDiagnostics = onOpenDiagnostics,
                    onOpenPermissionsStatus = onOpenPermissionsStatus,
                    onLogout = onLogout,
                )
            }
        }
    }
}

@Composable
private fun MoreScreen(
    onOpenPackages: () -> Unit,
    onOpenTransactions: () -> Unit,
    onOpenDeviceSetup: () -> Unit,
    onOpenDiagnostics: () -> Unit,
    onOpenPermissionsStatus: () -> Unit,
    onLogout: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        ListItem(
            headlineContent = { Text("Packages") },
            supportingContent = { Text("Browse the full catalog and pricing") },
            leadingContent = { Icon(Icons.Filled.List, contentDescription = null) },
            modifier = Modifier.clickable(onClick = onOpenPackages),
        )
        Divider()
        ListItem(
            headlineContent = { Text("Transaction History") },
            supportingContent = { Text("Orders you've completed") },
            leadingContent = { Icon(Icons.Filled.History, contentDescription = null) },
            modifier = Modifier.clickable(onClick = onOpenTransactions),
        )
        Divider()
        ListItem(
            headlineContent = { Text("Device") },
            supportingContent = { Text(DeviceIdentity.deviceName() ?: "Choose which registered device this phone is") },
            leadingContent = { Icon(Icons.Filled.PhoneAndroid, contentDescription = null) },
            modifier = Modifier.clickable(onClick = onOpenDeviceSetup),
        )
        Divider()
        ListItem(
            headlineContent = { Text("Diagnostics") },
            supportingContent = { Text("Recent errors and automatic retries on this device") },
            leadingContent = { Icon(Icons.Filled.BugReport, contentDescription = null) },
            modifier = Modifier.clickable(onClick = onOpenDiagnostics),
        )
        Divider()
        ListItem(
            headlineContent = { Text("Permissions") },
            supportingContent = { Text("SMS + background service status for this device") },
            leadingContent = { Icon(Icons.Filled.Security, contentDescription = null) },
            modifier = Modifier.clickable(onClick = onOpenPermissionsStatus),
        )
        Divider()
        ListItem(
            headlineContent = { Text("Log out") },
            leadingContent = { Icon(Icons.Filled.Logout, contentDescription = null) },
            modifier = Modifier.clickable(onClick = onLogout),
        )
    }
}
