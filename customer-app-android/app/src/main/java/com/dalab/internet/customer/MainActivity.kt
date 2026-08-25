package com.dalab.internet.customer

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.Crossfade
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Receipt
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Receipt
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.dalab.internet.customer.auth.AuthRepository
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.notifications.NotificationsBadgeState
import com.dalab.internet.customer.notifications.NotificationsDeepLink
import com.dalab.internet.customer.notifications.PushTokenRegistrar
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.ExchangeCorridor
import com.dalab.internet.customer.data.ExchangeOrder
import com.dalab.internet.customer.data.ExchangeWallet
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.data.PaymentWallet
import com.dalab.internet.customer.prefs.LocalizationManager
import com.dalab.internet.customer.prefs.ThemeManager
import com.dalab.internet.customer.queue.PendingActionQueue
import com.dalab.internet.customer.queue.QueueDrainer
import com.dalab.internet.customer.ui.CheckoutScreen
import com.dalab.internet.customer.ui.CompanyCategoriesScreen
import com.dalab.internet.customer.ui.CompanyPackagesScreen
import com.dalab.internet.customer.ui.DalabTheme
import com.dalab.internet.customer.ui.ExchangeCorridorsScreen
import com.dalab.internet.customer.ui.ExchangeNewOrderScreen
import com.dalab.internet.customer.ui.ExchangePaymentScreen
import com.dalab.internet.customer.ui.ExchangeStatusScreen
import com.dalab.internet.customer.ui.HomeScreen
import com.dalab.internet.customer.ui.NotificationsScreen
import com.dalab.internet.customer.ui.OrderDetailScreen
import com.dalab.internet.customer.ui.OrdersScreen
import com.dalab.internet.customer.ui.OtpLoginScreen
import com.dalab.internet.customer.ui.BottomNavItem
import com.dalab.internet.customer.ui.PaymentMethodScreen
import com.dalab.internet.customer.ui.PremiumBottomNav
import com.dalab.internet.customer.ui.ProfileScreen
import com.dalab.internet.customer.ui.ServiceSelectionScreen
import com.dalab.internet.customer.ui.SettingsScreen
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Deliberately no background service here (unlike the Agent App) — a
 * queued order isn't time-critical the way a missed agent-side payment
 * match is, so foreground-only draining (connectivity-restored callback +
 * resume) is a proportionate choice for this customer-facing app.
 */
class MainActivity : ComponentActivity() {
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val activityScope = CoroutineScope(Dispatchers.IO)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SessionManager.init(this)
        PendingActionQueue.init(this)
        registerConnectivityCallback()
        activityScope.launch { QueueDrainer.drainAll() }
        // Cold start: the notification tap itself launched this Activity, so
        // the extra is already on the very first Intent onCreate() sees.
        handleIntent(intent)

        setContent {
            DalabTheme(darkTheme = ThemeManager.isDark) {
                CustomerApp()
            }
        }
    }

    // Warm start: android:launchMode="singleTop" (manifest) routes a
    // notification tap here instead of spawning a second instance, while
    // this Activity is already showing some other screen.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_OPEN_NOTIFICATIONS, false) == true) {
            NotificationsDeepLink.pending = true
        }
    }

    override fun onResume() {
        super.onResume()
        activityScope.launch { QueueDrainer.drainAll() }
        // Proactive fallback in case a real push never arrives (or hasn't
        // been wired up on this build yet, see NotificationsBadgeState) --
        // catches up the unread count every time the app is foregrounded,
        // not just when the customer thinks to open Notifications.
        activityScope.launch { NotificationsBadgeState.refresh() }
    }

    override fun onDestroy() {
        networkCallback?.let {
            (getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)?.unregisterNetworkCallback(it)
        }
        networkCallback = null
        activityScope.cancel()
        super.onDestroy()
    }

    private fun registerConnectivityCallback() {
        val connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                activityScope.launch { QueueDrainer.drainAll() }
            }
        }
        connectivityManager.registerDefaultNetworkCallback(callback)
        networkCallback = callback
    }

    companion object {
        const val EXTRA_OPEN_NOTIFICATIONS = "open_notifications"
    }
}

private enum class Screen {
    LOGIN, SERVICE_SELECT,
    // Internet Store — untouched, never reachable from the Money Exchange stack below.
    HOME, COMPANY_CATEGORIES, CATEGORY_PACKAGES, PAYMENT_METHOD, CHECKOUT, ORDER_DETAIL,
    // Money Exchange — a separate main service, never reachable from the Internet stack above.
    EXCHANGE_CORRIDORS, EXCHANGE_NEW_ORDER, EXCHANGE_PAYMENT, EXCHANGE_STATUS,
}
private enum class HomeTab { HOME, ORDERS, PROFILE }

private data class CategorySelection(val id: String, val label: String, val packages: List<PackageItem>)
private data class CorridorSelection(val corridor: ExchangeCorridor, val fromWallet: ExchangeWallet?, val toWallet: ExchangeWallet?)

@Composable
private fun CustomerApp() {
    var screen by remember { mutableStateOf(if (SessionManager.isLoggedIn()) Screen.SERVICE_SELECT else Screen.LOGIN) }
    var selectedCompany by remember { mutableStateOf<Company?>(null) }
    var selectedCategory by remember { mutableStateOf<CategorySelection?>(null) }
    var checkoutSelection by remember { mutableStateOf<Pair<Company, PackageItem>?>(null) }
    var selectedWallet by remember { mutableStateOf<PaymentWallet?>(null) }
    var selectedOrder by remember { mutableStateOf<CustomerOrder?>(null) }
    var corridorSelection by remember { mutableStateOf<CorridorSelection?>(null) }
    var exchangeOrder by remember { mutableStateOf<ExchangeOrder?>(null) }

    // A notification was tapped (cold or warm start) -- jump to the Home
    // shell if we're not already there so CustomerHome's own effect (below)
    // can open Notifications. Only acts once logged in; otherwise the flag
    // stays set and is picked up the moment login completes and this effect
    // re-runs on the next screen change.
    LaunchedEffect(NotificationsDeepLink.pending, screen) {
        if (NotificationsDeepLink.pending && SessionManager.isLoggedIn() && screen != Screen.HOME) {
            screen = Screen.HOME
        }
    }

    when (screen) {
        Screen.LOGIN -> OtpLoginScreen(onLoggedIn = { screen = Screen.SERVICE_SELECT })

        // Open App -> Choose Service: Internet vs Money Exchange, two
        // entirely separate main services from here on — neither flow's
        // screens are ever reachable from the other.
        Screen.SERVICE_SELECT -> ServiceSelectionScreen(
            onSelectInternet = { screen = Screen.HOME },
            onSelectMoneyExchange = { screen = Screen.EXCHANGE_CORRIDORS },
        )

        Screen.HOME -> {
            val context = LocalContext.current
            val scope = rememberCoroutineScope()
            CustomerHome(
                onOpenCompany = { company -> selectedCompany = company; screen = Screen.COMPANY_CATEGORIES },
                onOpenOrder = { order -> selectedOrder = order; screen = Screen.ORDER_DETAIL },
                onLogout = {
                    // Must run before AuthRepository.logout() clears the session --
                    // unregistering needs the still-valid access token to authenticate
                    // the call. Best-effort: a stale token left behind just gets
                    // pruned server-side the next time a send to it fails.
                    scope.launch { PushTokenRegistrar.unregister(context) }
                    AuthRepository.logout()
                    screen = Screen.LOGIN
                },
                onSwitchService = { screen = Screen.SERVICE_SELECT },
            )
        }

        Screen.COMPANY_CATEGORIES -> selectedCompany?.let { company ->
            CompanyCategoriesScreen(
                company = company,
                onBack = { screen = Screen.HOME },
                onSelectCategory = { id, label, packages ->
                    selectedCategory = CategorySelection(id, label, packages)
                    screen = Screen.CATEGORY_PACKAGES
                },
            )
        }

        Screen.CATEGORY_PACKAGES -> selectedCompany?.let { company ->
            selectedCategory?.let { category ->
                CompanyPackagesScreen(
                    company = company,
                    categoryId = category.id,
                    categoryLabel = category.label,
                    initialPackages = category.packages,
                    onBack = { screen = Screen.COMPANY_CATEGORIES },
                    onBuy = { pkg -> checkoutSelection = company to pkg; screen = Screen.PAYMENT_METHOD },
                )
            }
        }

        Screen.PAYMENT_METHOD -> checkoutSelection?.let { (company, pkg) ->
            PaymentMethodScreen(
                company = company,
                pkg = pkg,
                onBack = { screen = Screen.CATEGORY_PACKAGES },
                onSelect = { wallet -> selectedWallet = wallet; screen = Screen.CHECKOUT },
            )
        }

        Screen.CHECKOUT -> checkoutSelection?.let { (company, pkg) ->
            selectedWallet?.let { wallet ->
                CheckoutScreen(
                    company = company,
                    pkg = pkg,
                    wallet = wallet,
                    onBack = { screen = Screen.PAYMENT_METHOD },
                    onOrderCreated = { order -> selectedOrder = order; screen = Screen.ORDER_DETAIL },
                )
            }
        }

        Screen.ORDER_DETAIL -> selectedOrder?.let { order ->
            OrderDetailScreen(initialOrder = order, onBack = { screen = Screen.HOME })
        }

        // ---- Money Exchange: Exchange -> Payment -> Confirmation ----
        Screen.EXCHANGE_CORRIDORS -> ExchangeCorridorsScreen(
            onBack = { screen = Screen.SERVICE_SELECT },
            onSelectCorridor = { corridor, fromWallet, toWallet ->
                corridorSelection = CorridorSelection(corridor, fromWallet, toWallet)
                screen = Screen.EXCHANGE_NEW_ORDER
            },
        )

        Screen.EXCHANGE_NEW_ORDER -> corridorSelection?.let { sel ->
            ExchangeNewOrderScreen(
                corridor = sel.corridor,
                fromWallet = sel.fromWallet,
                toWallet = sel.toWallet,
                onBack = { screen = Screen.EXCHANGE_CORRIDORS },
                onOrderCreated = { order -> exchangeOrder = order; screen = Screen.EXCHANGE_PAYMENT },
            )
        }

        Screen.EXCHANGE_PAYMENT -> exchangeOrder?.let { order ->
            ExchangePaymentScreen(
                order = order,
                fromWallet = corridorSelection?.fromWallet,
                onBack = { screen = Screen.EXCHANGE_NEW_ORDER },
                onContinue = { screen = Screen.EXCHANGE_STATUS },
            )
        }

        Screen.EXCHANGE_STATUS -> exchangeOrder?.let { order ->
            ExchangeStatusScreen(
                initialOrder = order,
                onBack = { screen = Screen.SERVICE_SELECT },
                onDone = { screen = Screen.SERVICE_SELECT },
            )
        }
    }
}

/** Bottom-nav shell for the logged-in customer: Home, Orders, Profile. */
@Composable
private fun CustomerHome(
    onOpenCompany: (Company) -> Unit,
    onOpenOrder: (CustomerOrder) -> Unit,
    onLogout: () -> Unit,
    onSwitchService: () -> Unit,
) {
    var tab by remember { mutableStateOf(HomeTab.HOME) }
    var showNotifications by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    val context = LocalContext.current

    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* Best-effort -- a denial just means no system-tray notification, the
          push itself still arrives and the unread badge still updates. */ }

    // Registers this device's FCM token (and requests POST_NOTIFICATIONS on
    // Android 13+) once the customer actually reaches Home -- covers both a
    // fresh login and a resumed session, since a valid session skips
    // OtpLoginScreen entirely on every subsequent cold start. Also does the
    // first badge refresh so the unread count is right from the moment Home
    // renders, not just after the first onResume().
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        PushTokenRegistrar.registerIfNeeded(context)
        NotificationsBadgeState.refresh()
    }

    // A notification was tapped -- open straight into Notifications. Only
    // ever one inbox, so no id needs to be threaded through.
    LaunchedEffect(NotificationsDeepLink.pending) {
        if (NotificationsDeepLink.pending) {
            NotificationsDeepLink.pending = false
            showNotifications = true
        }
    }

    if (showSettings) {
        SettingsScreen(onBack = { showSettings = false })
        return
    }
    if (showNotifications) {
        NotificationsScreen(onBack = { showNotifications = false })
        return
    }

    Scaffold(
        bottomBar = {
            PremiumBottomNav(
                items = listOf(
                    BottomNavItem(
                        label = LocalizationManager.tr("Home", "Guriga"),
                        selectedIcon = Icons.Filled.Home,
                        unselectedIcon = Icons.Outlined.Home,
                        selected = tab == HomeTab.HOME,
                        onClick = { tab = HomeTab.HOME },
                    ),
                    BottomNavItem(
                        label = LocalizationManager.tr("Orders", "Dalabyada"),
                        selectedIcon = Icons.Filled.Receipt,
                        unselectedIcon = Icons.Outlined.Receipt,
                        selected = tab == HomeTab.ORDERS,
                        onClick = { tab = HomeTab.ORDERS },
                    ),
                    BottomNavItem(
                        label = LocalizationManager.tr("Profile", "Xisaabta"),
                        selectedIcon = Icons.Filled.Person,
                        unselectedIcon = Icons.Outlined.Person,
                        selected = tab == HomeTab.PROFILE,
                        onClick = { tab = HomeTab.PROFILE },
                    ),
                ),
            )
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            Crossfade(targetState = tab, label = "homeTabCrossfade") { currentTab ->
                when (currentTab) {
                    HomeTab.HOME -> HomeScreen(
                        onOpenCompany = onOpenCompany,
                        onOpenNotifications = { showNotifications = true },
                        onOpenSettings = { showSettings = true },
                        onSwitchService = onSwitchService,
                    )
                    HomeTab.ORDERS -> OrdersScreen(onOpenOrder = onOpenOrder)
                    HomeTab.PROFILE -> ProfileScreen(onLogout = onLogout)
                }
            }
        }
    }
}
