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
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.filled.Sell
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import com.dalab.internet.auth.AuthRepository
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.data.Order
import com.dalab.internet.sms.SmsListenerState
import com.dalab.internet.ui.CustomersScreen
import com.dalab.internet.ui.LoginScreen
import com.dalab.internet.ui.NewSaleScreen
import com.dalab.internet.ui.OrderDetailScreen
import com.dalab.internet.ui.OrdersListScreen
import com.dalab.internet.ui.PackagesScreen
import com.dalab.internet.ui.ReportsScreen
import com.dalab.internet.ui.SmsPermissionScreen
import com.dalab.internet.ui.TransactionHistoryScreen

private val SMS_PERMISSIONS = arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS)

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SessionManager.init(this)
        SmsListenerState.init(this)
        createNotificationChannel()

        setContent {
            MaterialTheme {
                AgentApp()
            }
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                "payment_channel", "Payment detections", NotificationManager.IMPORTANCE_HIGH
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
}

private enum class Screen { PERMISSIONS, LOGIN, HOME, ORDER_DETAIL, PACKAGES, TRANSACTIONS }
private enum class HomeTab { ORDERS, SALES, CUSTOMERS, REPORTS, MORE }

@Composable
private fun AgentApp() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val activity = context as ComponentActivity

    fun smsGranted() = SMS_PERMISSIONS.all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }

    var hasSmsPermission by remember { mutableStateOf(smsGranted()) }
    var permanentlyDenied by remember { mutableStateOf(false) }
    var screen by remember {
        mutableStateOf(
            if (!hasSmsPermission) Screen.PERMISSIONS
            else if (!SessionManager.isLoggedIn()) Screen.LOGIN
            else Screen.HOME
        )
    }
    var selectedOrder by remember { mutableStateOf<Order?>(null) }

    val permissionLauncher = rememberLauncherForSmsPermissions(
        onResult = { grantedMap ->
            hasSmsPermission = grantedMap.values.all { it }
            if (hasSmsPermission) {
                SmsListenerState.setListening(true)
                screen = if (SessionManager.isLoggedIn()) Screen.HOME else Screen.LOGIN
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

        Screen.LOGIN -> LoginScreen(onLoggedIn = { screen = Screen.HOME })

        Screen.HOME -> AgentHome(
            onOpenOrder = { order -> selectedOrder = order; screen = Screen.ORDER_DETAIL },
            onOpenPackages = { screen = Screen.PACKAGES },
            onOpenTransactions = { screen = Screen.TRANSACTIONS },
            onLogout = { AuthRepository.logout(); screen = Screen.LOGIN },
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
    onLogout: () -> Unit,
) {
    var tab by remember { mutableStateOf(HomeTab.ORDERS) }

    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = tab == HomeTab.ORDERS,
                    onClick = { tab = HomeTab.ORDERS },
                    icon = { Icon(Icons.Filled.List, contentDescription = "Orders") },
                    label = { Text("Orders") },
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
                    onLogout = onLogout,
                )
            }
        }
    }
}

@Composable
private fun MoreScreen(onOpenPackages: () -> Unit, onOpenTransactions: () -> Unit, onLogout: () -> Unit) {
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
            headlineContent = { Text("Log out") },
            leadingContent = { Icon(Icons.Filled.Logout, contentDescription = null) },
            modifier = Modifier.clickable(onClick = onLogout),
        )
    }
}
