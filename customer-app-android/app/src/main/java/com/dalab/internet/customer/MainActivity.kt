package com.dalab.internet.customer

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
import com.dalab.internet.customer.auth.AuthRepository
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.CustomerOrder
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
import com.dalab.internet.customer.ui.HomeScreen
import com.dalab.internet.customer.ui.NotificationsScreen
import com.dalab.internet.customer.ui.OrderDetailScreen
import com.dalab.internet.customer.ui.OrdersScreen
import com.dalab.internet.customer.ui.OtpLoginScreen
import com.dalab.internet.customer.ui.BottomNavItem
import com.dalab.internet.customer.ui.PaymentBottomSheet
import com.dalab.internet.customer.ui.PaymentMethodScreen
import com.dalab.internet.customer.ui.PremiumBottomNav
import com.dalab.internet.customer.ui.ProfileScreen
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

        setContent {
            DalabTheme(darkTheme = ThemeManager.isDark) {
                CustomerApp()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        activityScope.launch { QueueDrainer.drainAll() }
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
}

private enum class Screen { LOGIN, HOME, COMPANY_CATEGORIES, CATEGORY_PACKAGES, PAYMENT_METHOD, CHECKOUT, ORDER_DETAIL }
private enum class HomeTab { HOME, ORDERS, PROFILE }

private data class CategorySelection(val id: String, val label: String, val packages: List<PackageItem>)

@Composable
private fun CustomerApp() {
    var screen by remember { mutableStateOf(if (SessionManager.isLoggedIn()) Screen.HOME else Screen.LOGIN) }
    var selectedCompany by remember { mutableStateOf<Company?>(null) }
    var selectedCategory by remember { mutableStateOf<CategorySelection?>(null) }
    var checkoutSelection by remember { mutableStateOf<Pair<Company, PackageItem>?>(null) }
    var selectedWallet by remember { mutableStateOf<PaymentWallet?>(null) }
    var selectedOrder by remember { mutableStateOf<CustomerOrder?>(null) }

    // Modern Payment Bottom Sheet: shown as an overlay right after an order
    // is created, on top of whatever screen it navigates to next (Order
    // Detail) — never a separate Screen state, so it doesn't affect back-nav.
    var paymentSheetState by remember { mutableStateOf<Triple<CustomerOrder, String?, Double>?>(null) }

    when (screen) {
        Screen.LOGIN -> OtpLoginScreen(onLoggedIn = { screen = Screen.HOME })

        Screen.HOME -> CustomerHome(
            onOpenCompany = { company -> selectedCompany = company; screen = Screen.COMPANY_CATEGORIES },
            onOpenOrder = { order -> selectedOrder = order; screen = Screen.ORDER_DETAIL },
            onLogout = { AuthRepository.logout(); screen = Screen.LOGIN },
        )

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
                    onOrderCreated = { order, dialTarget, finalAmount ->
                        selectedOrder = order
                        screen = Screen.ORDER_DETAIL
                        paymentSheetState = Triple(order, dialTarget, finalAmount)
                    },
                )
            }
        }

        Screen.ORDER_DETAIL -> selectedOrder?.let { order ->
            OrderDetailScreen(initialOrder = order, onBack = { screen = Screen.HOME })
        }
    }

    paymentSheetState?.let { (order, dialTarget, finalAmount) ->
        PaymentBottomSheet(
            initialOrder = order,
            packageName = checkoutSelection?.second?.name ?: order.packageName,
            amount = finalAmount,
            dialTarget = dialTarget,
            onDismiss = { paymentSheetState = null },
            onCompleted = { paymentSheetState = null },
        )
    }
}

/** Bottom-nav shell for the logged-in customer: Home, Orders, Profile. */
@Composable
private fun CustomerHome(
    onOpenCompany: (Company) -> Unit,
    onOpenOrder: (CustomerOrder) -> Unit,
    onLogout: () -> Unit,
) {
    var tab by remember { mutableStateOf(HomeTab.HOME) }
    var showNotifications by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }

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
                    )
                    HomeTab.ORDERS -> OrdersScreen(onOpenOrder = onOpenOrder)
                    HomeTab.PROFILE -> ProfileScreen(onLogout = onLogout, onOpenOrders = { tab = HomeTab.ORDERS })
                }
            }
        }
    }
}
