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
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.List
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.data.Order
import com.dalab.internet.sms.SmsListenerState
import com.dalab.internet.ui.LoginScreen
import com.dalab.internet.ui.OrderDetailScreen
import com.dalab.internet.ui.OrdersListScreen
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

private enum class Screen { PERMISSIONS, LOGIN, ORDERS, ORDER_DETAIL, TRANSACTIONS }

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
            else Screen.ORDERS
        )
    }
    var selectedOrder by remember { mutableStateOf<Order?>(null) }

    val permissionLauncher = rememberLauncherForSmsPermissions(
        onResult = { grantedMap ->
            hasSmsPermission = grantedMap.values.all { it }
            if (hasSmsPermission) {
                SmsListenerState.setListening(true)
                screen = if (SessionManager.isLoggedIn()) Screen.ORDERS else Screen.LOGIN
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

        Screen.LOGIN -> LoginScreen(onLoggedIn = { screen = Screen.ORDERS })

        Screen.ORDERS -> AgentHome(
            onOpenOrder = { order -> selectedOrder = order; screen = Screen.ORDER_DETAIL },
            onOpenTransactions = { screen = Screen.TRANSACTIONS },
        )

        Screen.ORDER_DETAIL -> selectedOrder?.let { order ->
            OrderDetailScreen(
                order = order,
                onBack = { screen = Screen.ORDERS },
                onOrderUpdated = { selectedOrder = it },
            )
        }

        Screen.TRANSACTIONS -> TransactionHistoryScreen()
    }
}

@Composable
private fun rememberLauncherForSmsPermissions(
    onResult: (Map<String, Boolean>) -> Unit
) = androidx.activity.compose.rememberLauncherForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions(), onResult
)

/** Simple bottom-nav shell around Orders / Transactions for the logged-in agent. */
@Composable
private fun AgentHome(onOpenOrder: (Order) -> Unit, onOpenTransactions: () -> Unit) {
    var tab by remember { mutableStateOf(0) }

    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = tab == 0,
                    onClick = { tab = 0 },
                    icon = { Icon(Icons.Filled.List, contentDescription = "Orders") },
                    label = { Text("Orders") },
                )
                NavigationBarItem(
                    selected = tab == 1,
                    onClick = { tab = 1; onOpenTransactions() },
                    icon = { Icon(Icons.Filled.History, contentDescription = "History") },
                    label = { Text("History") },
                )
            }
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            if (tab == 0) OrdersListScreen(onOpenOrder = onOpenOrder)
            else TransactionHistoryScreen()
        }
    }
}
