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
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.Assessment
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.Campaign
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
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Storefront
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.auth.ResellerSessionManager
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.data.ExchangeOrder
import com.dalab.internet.data.Order
import com.dalab.internet.data.ShopAgentOrder
import com.dalab.internet.data.VipNumberAgentOrder
import com.dalab.internet.data.VipPackageAgentOrder
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.diagnostics.HeartbeatStats
import com.dalab.internet.network.ApiClient
import com.dalab.internet.notifications.AgentAlertsState
import com.dalab.internet.notifications.OrdersDeepLink
import com.dalab.internet.notifications.PushTokenRegistrar
import com.dalab.internet.notifications.SupportDeepLink
import com.dalab.internet.notifications.SupportUnreadState
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.service.AgentBackgroundService
import com.dalab.internet.sms.SmsInboxScanner
import com.dalab.internet.sms.SmsListenerState
import com.dalab.internet.ui.AgentOrdersScreen
import com.dalab.internet.ui.OrdersTopTab
import com.dalab.internet.ui.VipOrdersSubTab
import com.dalab.internet.ui.AlertsScreen
import com.dalab.internet.ui.AutoLoginScreen
import com.dalab.internet.ui.CustomerDetailScreen
import com.dalab.internet.ui.CustomersScreen
import com.dalab.internet.ui.DeviceSetupScreen
import com.dalab.internet.ui.DiagnosticsScreen
import com.dalab.internet.ui.ExchangeAccessibilitySetupScreen
import com.dalab.internet.ui.ExchangeOrderDetailScreen
import com.dalab.internet.ui.ResellerWithdrawalInteractiveAccessibilitySetupScreen
import com.dalab.internet.ui.ExchangeOrdersListScreen
import com.dalab.internet.ui.NalaSocoManagementScreen
import com.dalab.internet.ui.NewSaleScreen
import com.dalab.internet.ui.NotificationsScreen
import com.dalab.internet.ui.OrderDetailScreen
import com.dalab.internet.ui.OrdersListScreen
import com.dalab.internet.ui.PackagesScreen
import com.dalab.internet.ui.PermissionsStatusScreen
import com.dalab.internet.ui.ReliabilityDashboardScreen
import com.dalab.internet.ui.ReliabilitySetupScreen
import com.dalab.internet.ui.ReportsScreen
import com.dalab.internet.ui.ResellerScreen
import com.dalab.internet.ui.ShopAgentOrderDetailScreen
import com.dalab.internet.ui.SmsPermissionScreen
import com.dalab.internet.ui.SupportScreen
import com.dalab.internet.ui.TransactionHistoryScreen
import com.dalab.internet.ui.VipNumberAgentOrderDetailScreen
import com.dalab.internet.ui.VipPackageAgentOrderDetailScreen
import com.dalab.internet.ui.WalletDashboardScreen
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
        safely("reseller_session_init") { ResellerSessionManager.init(this) }
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
        if (intent == null) return
        // Two different tap paths land here with two different extra
        // shapes:
        //  - Foreground (AgentFcmService.onMessageReceived ran): the custom
        //    EXTRA_OPEN_SUPPORT/EXTRA_OPEN_ORDERS/EXTRA_ORDER_* names below,
        //    built explicitly by that code.
        //  - Background/killed (FCM auto-displayed the notification itself,
        //    onMessageReceived never ran): the system instead launches with
        //    the RAW data-payload keys as extras, under their original
        //    names ("screen"/"orderType"/"orderId") -- not the MainActivity
        //    constants, since no app code executed to remap them. Checking
        //    both is what makes "tap deep-links correctly" true regardless
        //    of whether the app was alive when the push arrived.
        val rawScreen = intent.getStringExtra("screen")
        if (intent.getBooleanExtra(EXTRA_OPEN_SUPPORT, false) || rawScreen == "support_conversation") {
            SupportDeepLink.pending = true
        }
        if (intent.getBooleanExtra(EXTRA_OPEN_ORDERS, false) || rawScreen == "agent_orders") {
            // Set together, before pending -- AgentApp()'s effect reads
            // orderType/orderId the moment pending flips true.
            OrdersDeepLink.orderType = intent.getStringExtra(EXTRA_ORDER_TYPE) ?: intent.getStringExtra("orderType")
            OrdersDeepLink.orderId = intent.getStringExtra(EXTRA_ORDER_ID) ?: intent.getStringExtra("orderId")
            OrdersDeepLink.pending = true
        }
    }

    companion object {
        const val EXTRA_OPEN_SUPPORT = "open_support"
        const val EXTRA_OPEN_ORDERS = "open_orders"
        const val EXTRA_ORDER_TYPE = "order_type"
        const val EXTRA_ORDER_ID = "order_id"
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

private enum class Screen { PERMISSIONS, DEVICE_SETUP, AUTHENTICATING, RELIABILITY_SETUP, HOME, ORDER_DETAIL, PACKAGES, TRANSACTIONS, WALLET, DIAGNOSTICS, PERMISSIONS_STATUS, RELIABILITY_DASHBOARD, EXCHANGE_LIST, EXCHANGE_DETAIL, EXCHANGE_SETUP, ALERTS, RESELLER_WITHDRAWAL_INTERACTIVE_SETUP, SALES, CUSTOMERS, CUSTOMER_DETAIL, REPORTS, RESELLER, AGENT_SHOP_ORDER_DETAIL, AGENT_VIP_ORDER_DETAIL, AGENT_VIP_PACKAGE_ORDER_DETAIL, NALA_SOCO }
// Bottom nav is exactly 5 tabs: Home, Orders, Support Agent, Broadcast, More --
// Sales/Customers/Reports (formerly their own tabs) moved under More as
// ordinary Screen.X destinations instead (see MoreScreen's "My Work"
// section), and Support/Broadcast (formerly under More) became tabs here.
// Orders is the real Shop/VIP Number order queue (see AgentOrdersScreen) --
// distinct from Home's existing Internet Store recharge queue
// (OrdersListScreen/Order), same "own tab per business line" pattern
// Money Exchange/Reseller Withdrawal already follow.
private enum class HomeTab { HOME, ORDERS, SUPPORT, BROADCAST, MORE }

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
    var selectedAgentShopOrder by remember { mutableStateOf<ShopAgentOrder?>(null) }
    var selectedAgentVipOrder by remember { mutableStateOf<VipNumberAgentOrder?>(null) }
    var selectedAgentVipPackageOrder by remember { mutableStateOf<VipPackageAgentOrder?>(null) }
    var selectedCustomerId by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // Back navigation for every normal in-app destination -- a real stack of
    // where `screen` has been, not a hardcoded "always return to Home".
    // navigate() pushes the screen being left before switching; goBack()
    // pops it. Every onBack callback below calls goBack() instead of
    // hardcoding its own idea of "the" previous screen, so Back always
    // lands wherever the agent actually came from (Orders tab, More tab,
    // a list screen, etc.) -- see also homeTab/ordersTopTab/ordersVipSubTab
    // below, hoisted out of AgentHome/AgentOrdersScreen for the same reason:
    // their own local `remember` state would otherwise reset every time
    // this composable leaves Screen.HOME and comes back.
    val backStack = remember { mutableStateListOf<Screen>() }
    fun navigate(to: Screen) {
        backStack.add(screen)
        screen = to
    }
    fun goBack() {
        screen = backStack.removeLastOrNull() ?: Screen.HOME
    }

    // AgentHome's bottom-nav tab, and AgentOrdersScreen's own Shop/VIP
    // Numbers top-tab + Numbers/Packages sub-tab -- hoisted here (rather
    // than each screen's own local `remember`) so they survive navigating
    // into an order's/Report's/etc. detail screen and back. Onboarding
    // screens (PERMISSIONS/DEVICE_SETUP/AUTHENTICATING/RELIABILITY_SETUP)
    // never touch these; they only matter once `screen` is Screen.HOME.
    var homeTab by remember { mutableStateOf(HomeTab.HOME) }
    var ordersTopTab by remember { mutableStateOf(OrdersTopTab.SHOP) }
    var ordersVipSubTab by remember { mutableStateOf(VipOrdersSubTab.NUMBERS) }

    // System back gesture/button mirrors the in-app Back arrows above: pop
    // the stack if there's somewhere to pop to, otherwise fall back to the
    // Home tab if on some other tab -- only truly exits the app (default,
    // unhandled behavior) once at the real root, same as before this fix.
    BackHandler(enabled = backStack.isNotEmpty() || homeTab != HomeTab.HOME) {
        if (backStack.isNotEmpty()) goBack() else homeTab = HomeTab.HOME
    }

    // A support-request push (support.routes.ts's notifyAssignedAgent()/
    // notifyAgentOfNewMessage()) was tapped -- jump to Home so AgentHome gets
    // composed, which is where the flag is actually consumed (it switches its
    // own Support tab -- see AgentHome's own LaunchedEffect below). Only
    // forces navigation once logged in and past setup -- an agent who somehow
    // taps a notification before finishing device setup just lands wherever
    // setup leaves them; the flag stays set and is picked up the next time
    // this effect re-runs, same as before.
    LaunchedEffect(SupportDeepLink.pending) {
        if (SupportDeepLink.pending && screen != Screen.HOME) {
            screen = Screen.HOME
        }
    }

    // A payment-confirmed order push was tapped -- same "get to Screen.HOME
    // first, AgentHome's own effect below picks the tab" pattern as the
    // support deep link above.
    LaunchedEffect(OrdersDeepLink.pending) {
        if (OrdersDeepLink.pending && screen != Screen.HOME) {
            screen = Screen.HOME
        }
    }

    // Once actually on Home (session resolved, setup done), a VIP Number/
    // Package order push jumps straight to that order's own detail screen
    // instead of leaving AgentHome's own effect open the Orders tab --
    // this is the "tapping the notification opens the correct VIP Order
    // Detail screen" requirement. Shop pushes (orderType "shop") and any
    // push with no orderId (an older/unrecognized payload) are left alone
    // here on purpose: pending stays true, so AgentHome's own effect below
    // still runs its Orders-tab fallback exactly as before. Only clears
    // pending/orderId/orderType on success -- a fetch failure (network
    // drop, the order somehow 404s) also falls through to that same
    // fallback rather than stranding the agent on a blank screen.
    LaunchedEffect(OrdersDeepLink.pending, screen) {
        if (!OrdersDeepLink.pending || screen != Screen.HOME) return@LaunchedEffect
        val orderId = OrdersDeepLink.orderId
        val orderType = OrdersDeepLink.orderType
        if (orderId == null || (orderType != "vip_number" && orderType != "vip_package")) return@LaunchedEffect
        // Only clear the deep link once navigation has actually happened --
        // a non-exceptional but empty body (shouldn't happen, but isn't
        // impossible) must still fall through to AgentHome's Orders-tab
        // fallback rather than silently discarding the tap.
        val navigated = try {
            if (orderType == "vip_number") {
                val order = ApiClient.service.getAgentVipNumberOrder(orderId).body()
                if (order != null) {
                    selectedAgentVipOrder = order
                    screen = Screen.AGENT_VIP_ORDER_DETAIL
                }
                order != null
            } else {
                val order = ApiClient.service.getAgentVipPackageOrder(orderId).body()
                if (order != null) {
                    selectedAgentVipPackageOrder = order
                    screen = Screen.AGENT_VIP_PACKAGE_ORDER_DETAIL
                }
                order != null
            }
        } catch (_: Exception) {
            false
        }
        if (navigated) {
            OrdersDeepLink.pending = false
        } else {
            // Fetch failed -- clear the order-specific fields (leaving
            // pending=true) so AgentHome's own effect, keyed on orderType,
            // re-evaluates and takes over as the Orders-tab fallback
            // instead of this order staying silently un-openable.
            OrdersDeepLink.orderType = null
        }
        OrdersDeepLink.orderId = null
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
            tab = homeTab,
            onTabChange = { homeTab = it },
            ordersTopTab = ordersTopTab,
            onOrdersTopTabChange = { ordersTopTab = it },
            ordersVipSubTab = ordersVipSubTab,
            onOrdersVipSubTabChange = { ordersVipSubTab = it },
            onOpenOrder = { order -> selectedOrder = order; navigate(Screen.ORDER_DETAIL) },
            onOpenAgentShopOrder = { order -> selectedAgentShopOrder = order; navigate(Screen.AGENT_SHOP_ORDER_DETAIL) },
            onOpenAgentVipOrder = { order -> selectedAgentVipOrder = order; navigate(Screen.AGENT_VIP_ORDER_DETAIL) },
            onOpenAgentVipPackageOrder = { order -> selectedAgentVipPackageOrder = order; navigate(Screen.AGENT_VIP_PACKAGE_ORDER_DETAIL) },
            onOpenPackages = { navigate(Screen.PACKAGES) },
            onOpenTransactions = { navigate(Screen.TRANSACTIONS) },
            onOpenWallet = { navigate(Screen.WALLET) },
            onOpenDeviceSetup = { navigate(Screen.DEVICE_SETUP) },
            onOpenDiagnostics = { navigate(Screen.DIAGNOSTICS) },
            onOpenPermissionsStatus = { navigate(Screen.PERMISSIONS_STATUS) },
            onOpenReliabilityDashboard = { navigate(Screen.RELIABILITY_DASHBOARD) },
            onOpenMoneyExchange = { navigate(Screen.EXCHANGE_LIST) },
            onOpenAlerts = { navigate(Screen.ALERTS) },
            onOpenResellerWithdrawalSetup = { navigate(Screen.RESELLER_WITHDRAWAL_INTERACTIVE_SETUP) },
            onOpenSales = { navigate(Screen.SALES) },
            onOpenCustomers = { navigate(Screen.CUSTOMERS) },
            onOpenReports = { navigate(Screen.REPORTS) },
            onOpenReseller = { navigate(Screen.RESELLER) },
            onOpenNalaSoco = { navigate(Screen.NALA_SOCO) },
        )

        Screen.ORDER_DETAIL -> selectedOrder?.let { order ->
            OrderDetailScreen(
                order = order,
                onBack = { goBack() },
                onOrderUpdated = { selectedOrder = it },
            )
        }

        Screen.PACKAGES -> PackagesScreen(onBack = { goBack() })

        Screen.TRANSACTIONS -> TransactionHistoryScreen(onBack = { goBack() })

        Screen.WALLET -> WalletDashboardScreen(onBack = { goBack() })

        Screen.DIAGNOSTICS -> DiagnosticsScreen(onBack = { goBack() })

        Screen.PERMISSIONS_STATUS -> PermissionsStatusScreen(onBack = { goBack() })

        Screen.RELIABILITY_DASHBOARD -> ReliabilityDashboardScreen(onBack = { goBack() })

        Screen.EXCHANGE_LIST -> ExchangeOrdersListScreen(
            onOpenOrder = { order -> selectedExchangeOrder = order; navigate(Screen.EXCHANGE_DETAIL) },
            onOpenSetup = { navigate(Screen.EXCHANGE_SETUP) },
            onBack = { goBack() },
        )

        Screen.EXCHANGE_DETAIL -> selectedExchangeOrder?.let { order ->
            ExchangeOrderDetailScreen(
                order = order,
                onBack = { goBack() },
                onOrderUpdated = { selectedExchangeOrder = it },
            )
        }

        Screen.EXCHANGE_SETUP -> ExchangeAccessibilitySetupScreen(onBack = { goBack() })

        Screen.ALERTS -> AlertsScreen(onBack = { goBack() })

        Screen.NALA_SOCO -> NalaSocoManagementScreen(onBack = { goBack() })

        Screen.RESELLER_WITHDRAWAL_INTERACTIVE_SETUP -> ResellerWithdrawalInteractiveAccessibilitySetupScreen(onBack = { goBack() })

        Screen.SALES -> NewSaleScreen(onBack = { goBack() })

        Screen.CUSTOMERS -> CustomersScreen(
            onBack = { goBack() },
            onOpenCustomer = { customerId -> selectedCustomerId = customerId; navigate(Screen.CUSTOMER_DETAIL) },
        )

        Screen.CUSTOMER_DETAIL -> selectedCustomerId?.let { customerId ->
            CustomerDetailScreen(customerId = customerId, onBack = { goBack() })
        }

        Screen.REPORTS -> ReportsScreen(onBack = { goBack() })

        Screen.RESELLER -> ResellerScreen(onBack = { goBack() })

        Screen.AGENT_SHOP_ORDER_DETAIL -> selectedAgentShopOrder?.let { order ->
            ShopAgentOrderDetailScreen(
                order = order,
                onBack = { goBack() },
                onOrderUpdated = { selectedAgentShopOrder = it },
            )
        }

        Screen.AGENT_VIP_ORDER_DETAIL -> selectedAgentVipOrder?.let { order ->
            VipNumberAgentOrderDetailScreen(
                order = order,
                onBack = { goBack() },
                onOrderUpdated = { selectedAgentVipOrder = it },
            )
        }

        Screen.AGENT_VIP_PACKAGE_ORDER_DETAIL -> selectedAgentVipPackageOrder?.let { order ->
            VipPackageAgentOrderDetailScreen(
                order = order,
                onBack = { goBack() },
                onOrderUpdated = { selectedAgentVipPackageOrder = it },
            )
        }
    }
}

@Composable
private fun rememberLauncherForSmsPermissions(
    onResult: (Map<String, Boolean>) -> Unit
) = androidx.activity.compose.rememberLauncherForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions(), onResult
)

/** Bottom-nav shell for the logged-in agent: Home, Support Agent, Broadcast, More. */
@Composable
private fun AgentHome(
    tab: HomeTab,
    onTabChange: (HomeTab) -> Unit,
    ordersTopTab: OrdersTopTab,
    onOrdersTopTabChange: (OrdersTopTab) -> Unit,
    ordersVipSubTab: VipOrdersSubTab,
    onOrdersVipSubTabChange: (VipOrdersSubTab) -> Unit,
    onOpenOrder: (Order) -> Unit,
    onOpenAgentShopOrder: (ShopAgentOrder) -> Unit,
    onOpenAgentVipOrder: (VipNumberAgentOrder) -> Unit,
    onOpenAgentVipPackageOrder: (VipPackageAgentOrder) -> Unit,
    onOpenPackages: () -> Unit,
    onOpenTransactions: () -> Unit,
    onOpenWallet: () -> Unit,
    onOpenDeviceSetup: () -> Unit,
    onOpenDiagnostics: () -> Unit,
    onOpenPermissionsStatus: () -> Unit,
    onOpenReliabilityDashboard: () -> Unit,
    onOpenMoneyExchange: () -> Unit,
    onOpenAlerts: () -> Unit,
    onOpenResellerWithdrawalSetup: () -> Unit,
    onOpenSales: () -> Unit,
    onOpenCustomers: () -> Unit,
    onOpenReports: () -> Unit,
    onOpenReseller: () -> Unit,
    onOpenNalaSoco: () -> Unit,
) {

    // A support push tapped while this composable already exists (warm
    // start, or the agent was mid-session on some other tab) -- AgentApp's
    // own effect only gets the agent as far as Screen.HOME; this is what
    // actually switches to the Support tab and clears the badge. `tab` is
    // now hoisted up to AgentApp, so this goes through onTabChange.
    LaunchedEffect(SupportDeepLink.pending) {
        if (SupportDeepLink.pending) {
            SupportDeepLink.pending = false
            onTabChange(HomeTab.SUPPORT)
            SupportUnreadState.clear()
        }
    }

    // Same warm/cold-start coverage as the support deep link above, for a
    // payment-confirmed Shop/VIP order push -- AgentApp's own effect can
    // only get the agent as far as Screen.HOME, so this is what actually
    // switches to the Orders tab. Skips (leaves pending untouched) for a
    // VIP Number/Package push: AgentApp's own effect owns that case
    // end-to-end (fetches the order, navigates straight to its detail
    // screen, clears pending itself) -- clearing it here first would race
    // that still-in-flight fetch and strand the agent on the Orders tab
    // instead.
    LaunchedEffect(OrdersDeepLink.pending, OrdersDeepLink.orderType) {
        if (!OrdersDeepLink.pending) return@LaunchedEffect
        val orderType = OrdersDeepLink.orderType
        if (OrdersDeepLink.orderId != null && (orderType == "vip_number" || orderType == "vip_package")) return@LaunchedEffect
        OrdersDeepLink.pending = false
        onTabChange(HomeTab.ORDERS)
    }

    // Covers a support push that arrived while the app was backgrounded or
    // killed -- the OS shows the system-tray notification straight from the
    // FCM payload in that case, bypassing AgentFcmService.onMessageReceived
    // (and therefore SupportUnreadState.markUnread()) entirely. If the agent
    // reopens the app normally (tapping the launcher icon, not the
    // notification) rather than through the deep link above, this is what
    // still shows the badge for whatever's waiting.
    LaunchedEffect(Unit) {
        try {
            val status = ApiClient.service.getSupportStatus().body()
            if (status?.activeConversationId != null) SupportUnreadState.markUnread()
        } catch (e: Exception) {
            DiagnosticsLog.record("support_unread_check", "Failed: ${e.message}")
        }
    }

    Scaffold(
        bottomBar = {
            DalabBottomNavigation(
                selectedTab = tab,
                onSelectTab = { newTab ->
                    onTabChange(newTab)
                    if (newTab == HomeTab.SUPPORT) SupportUnreadState.clear()
                },
                supportHasUnread = SupportUnreadState.hasUnread,
            )
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            when (tab) {
                HomeTab.HOME -> OrdersListScreen(
                    onOpenOrder = onOpenOrder,
                    onOpenAlerts = onOpenAlerts,
                )
                HomeTab.ORDERS -> AgentOrdersScreen(
                    topTab = ordersTopTab,
                    onTopTabChange = onOrdersTopTabChange,
                    vipSubTab = ordersVipSubTab,
                    onVipSubTabChange = onOrdersVipSubTabChange,
                    onOpenShopOrder = onOpenAgentShopOrder,
                    onOpenVipOrder = onOpenAgentVipOrder,
                    onOpenVipPackageOrder = onOpenAgentVipPackageOrder,
                )
                HomeTab.SUPPORT -> SupportScreen(onBack = { onTabChange(HomeTab.HOME) })
                HomeTab.BROADCAST -> NotificationsScreen(onBack = { onTabChange(HomeTab.HOME) })
                HomeTab.MORE -> MoreScreen(
                    onOpenPackages = onOpenPackages,
                    onOpenTransactions = onOpenTransactions,
                    onOpenWallet = onOpenWallet,
                    onOpenDeviceSetup = onOpenDeviceSetup,
                    onOpenDiagnostics = onOpenDiagnostics,
                    onOpenPermissionsStatus = onOpenPermissionsStatus,
                    onOpenReliabilityDashboard = onOpenReliabilityDashboard,
                    onOpenMoneyExchange = onOpenMoneyExchange,
                    onOpenResellerWithdrawalSetup = onOpenResellerWithdrawalSetup,
                    onOpenSales = onOpenSales,
                    onOpenCustomers = onOpenCustomers,
                    onOpenReports = onOpenReports,
                    onOpenReseller = onOpenReseller,
                    onOpenNalaSoco = onOpenNalaSoco,
                )
            }
        }
    }
}

private data class BottomNavTab(
    val tab: HomeTab,
    val icon: androidx.compose.ui.graphics.vector.ImageVector,
    val label: String,
)

private val BOTTOM_NAV_TABS = listOf(
    BottomNavTab(HomeTab.HOME, Icons.Filled.Home, "Home"),
    BottomNavTab(HomeTab.ORDERS, Icons.Filled.ShoppingCart, "Orders"),
    BottomNavTab(HomeTab.SUPPORT, Icons.Filled.SupportAgent, "Support Agent"),
    BottomNavTab(HomeTab.BROADCAST, Icons.Filled.Notifications, "Broadcast"),
    BottomNavTab(HomeTab.MORE, Icons.Filled.MoreHoriz, "More"),
)

/**
 * Same 5 tabs, same routes/onClick logic, same colors as the plain
 * NavigationBar this replaces -- every NavigationBarItem below still exists
 * with its normal selected/onClick/label, so click targets, ripple, and
 * TalkBack semantics (selected tab announced, etc.) are all exactly what
 * they were. The only change is purely visual: instead of each item fading
 * its own indicator in behind its own icon, a single shared circular
 * indicator slides horizontally to whichever tab is selected and floats
 * slightly above the bar's top edge, matching the reference animation
 * (icon lifts into an elevated circular badge; the tab it leaves smoothly
 * returns to a plain icon on the flat bar).
 *
 * How: each item's own icon is rendered fully transparent while selected
 * (tint animates out) -- the floating circle overlay, drawn after
 * (on top of) the NavigationBar, draws that same icon itself, in the
 * selected color, inside the badge. Position math is plain division by
 * BOTTOM_NAV_TABS.size (NavigationBar lays its items out in equal-width
 * columns internally), not per-item position tracking, so there's no
 * onGloballyPositioned/measurement coupling to get wrong or destabilize.
 * Every animated value is a plain animateDpAsState/animateColorAsState --
 * no custom Shape/Path math, no third-party animation library.
 */
@Composable
private fun DalabBottomNavigation(
    selectedTab: HomeTab,
    onSelectTab: (HomeTab) -> Unit,
    supportHasUnread: Boolean,
) {
    val selectedIndex = BOTTOM_NAV_TABS.indexOfFirst { it.tab == selectedTab }
    // The exact same tokens NavigationBarItemDefaults.colors() already
    // resolves to today, so this is purely an animation change -- the
    // brand-neutral colors this bar has always shown are unchanged.
    val indicatorColor = MaterialTheme.colorScheme.secondaryContainer
    val selectedIconColor = MaterialTheme.colorScheme.onSecondaryContainer
    val unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant

    Box {
        NavigationBar {
            BOTTOM_NAV_TABS.forEach { spec ->
                val selected = spec.tab == selectedTab
                val iconTint by animateColorAsState(
                    targetValue = if (selected) Color.Transparent else unselectedIconColor,
                    label = "navIconTint",
                )
                NavigationBarItem(
                    selected = selected,
                    onClick = { onSelectTab(spec.tab) },
                    icon = {
                        if (spec.tab == HomeTab.SUPPORT) {
                            BadgedBox(badge = { if (supportHasUnread && !selected) Badge() }) {
                                Icon(spec.icon, contentDescription = spec.label, tint = iconTint)
                            }
                        } else {
                            Icon(spec.icon, contentDescription = spec.label, tint = iconTint)
                        }
                    },
                    label = { Text(spec.label) },
                    colors = NavigationBarItemDefaults.colors(indicatorColor = Color.Transparent),
                )
            }
        }

        // The single shared elevated circular indicator -- see this
        // function's own doc comment above for why it's a separate overlay
        // rather than each item's own indicator.
        BoxWithConstraints(Modifier.matchParentSize()) {
            val itemWidth = maxWidth / BOTTOM_NAV_TABS.size
            val indicatorSize = 44.dp
            val indicatorX by animateDpAsState(
                targetValue = itemWidth * selectedIndex + (itemWidth - indicatorSize) / 2,
                animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMediumLow),
                label = "navIndicatorX",
            )
            Surface(
                color = indicatorColor,
                shape = CircleShape,
                shadowElevation = 6.dp,
                modifier = Modifier
                    .offset(x = indicatorX, y = (-16).dp)
                    .size(indicatorSize),
            ) {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
                    Icon(
                        BOTTOM_NAV_TABS[selectedIndex].icon,
                        contentDescription = null,
                        tint = selectedIconColor,
                    )
                }
            }
        }
    }
}

/**
 * Grouped into categories instead of one long flat list, so an agent
 * scanning for something specific isn't reading past unrelated items — My
 * Work first (Sales/Customers/Reports, demoted here from their own bottom-nav
 * tabs when the bar was cut down to exactly 4), then Money, then Catalog &
 * Sales, then Device & Diagnostics (setup/troubleshooting, checked least
 * often). Agent Support and Customer Broadcast are no longer here at all —
 * they're their own bottom-nav tabs now (Support Agent / Broadcast).
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
    onOpenResellerWithdrawalSetup: () -> Unit,
    onOpenSales: () -> Unit,
    onOpenCustomers: () -> Unit,
    onOpenReports: () -> Unit,
    onOpenReseller: () -> Unit,
    onOpenNalaSoco: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        // Sales/Customers/Reports were their own bottom-nav tabs before the
        // bar was cut down to exactly 4 (Home/Support Agent/Broadcast/More)
        // to make room for Support Agent and Broadcast -- kept first and
        // together here since they're still core, frequently-used agent
        // work, not just occasional setup/diagnostics.
        MoreSection(title = "My Work") {
            MoreItem(
                title = "Sales",
                subtitle = "Start a new sale for a walk-in customer",
                icon = Icons.Filled.Sell,
                onClick = onOpenSales,
            )
            MoreItem(
                title = "Customers",
                subtitle = "Search or register customers",
                icon = Icons.Filled.People,
                onClick = onOpenCustomers,
            )
            MoreItem(
                title = "Reports",
                subtitle = "Your completed-sales totals and breakdown",
                icon = Icons.Filled.Assessment,
                onClick = onOpenReports,
            )
        }
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
            // Log in with a Reseller ID + PIN to see that reseller's own
            // balance, orders, deposits, and withdrawals -- the exact same
            // Admin Reseller system (see MainActivity's ResellerScreen /
            // ui/ResellerScreens.kt), just reachable from here instead of
            // only from the Admin Dashboard.
            MoreItem(
                title = "Reseller",
                subtitle = "Log in as a Reseller: balance, orders, deposits, withdrawals",
                icon = Icons.Filled.Storefront,
                onClick = onOpenReseller,
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
            // Same create/edit/publish/delete capability the Admin dashboard's
            // own Nala Soco section has -- see NalaSocoManagementScreen's own
            // doc comment.
            MoreItem(
                title = "Nala Soco",
                subtitle = "Manage announcements shown in the Customer App",
                icon = Icons.Filled.Campaign,
                onClick = onOpenNalaSoco,
            )
        }
        // Agent Support and Customer Broadcast moved to their own bottom-nav
        // tabs (Support Agent / Broadcast) -- no longer listed here.
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
