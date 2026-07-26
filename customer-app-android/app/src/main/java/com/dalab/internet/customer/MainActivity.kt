package com.dalab.internet.customer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Receipt
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.dalab.internet.customer.auth.AuthRepository
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.ui.CheckoutScreen
import com.dalab.internet.customer.ui.CompanyPackagesScreen
import com.dalab.internet.customer.ui.HomeScreen
import com.dalab.internet.customer.ui.MacaashScreen
import com.dalab.internet.customer.ui.OrderDetailScreen
import com.dalab.internet.customer.ui.OrdersScreen
import com.dalab.internet.customer.ui.OtpLoginScreen
import com.dalab.internet.customer.ui.ProfileScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SessionManager.init(this)

        setContent {
            MaterialTheme {
                CustomerApp()
            }
        }
    }
}

private enum class Screen { LOGIN, HOME, COMPANY_PACKAGES, CHECKOUT, ORDER_DETAIL }
private enum class HomeTab { HOME, MACAASH, ORDERS, PROFILE }

@Composable
private fun CustomerApp() {
    var screen by remember { mutableStateOf(if (SessionManager.isLoggedIn()) Screen.HOME else Screen.LOGIN) }
    var selectedCompany by remember { mutableStateOf<Company?>(null) }
    var checkoutSelection by remember { mutableStateOf<Pair<Company, PackageItem>?>(null) }
    var selectedOrder by remember { mutableStateOf<CustomerOrder?>(null) }

    when (screen) {
        Screen.LOGIN -> OtpLoginScreen(onLoggedIn = { screen = Screen.HOME })

        Screen.HOME -> CustomerHome(
            onOpenCompany = { company -> selectedCompany = company; screen = Screen.COMPANY_PACKAGES },
            onOpenOrder = { order -> selectedOrder = order; screen = Screen.ORDER_DETAIL },
            onLogout = { AuthRepository.logout(); screen = Screen.LOGIN },
        )

        Screen.COMPANY_PACKAGES -> selectedCompany?.let { company ->
            CompanyPackagesScreen(
                company = company,
                onBack = { screen = Screen.HOME },
                onBuy = { pkg -> checkoutSelection = company to pkg; screen = Screen.CHECKOUT },
            )
        }

        Screen.CHECKOUT -> checkoutSelection?.let { (company, pkg) ->
            CheckoutScreen(
                company = company,
                pkg = pkg,
                onBack = { screen = Screen.HOME },
                onOrderCreated = { order -> selectedOrder = order; screen = Screen.ORDER_DETAIL },
            )
        }

        Screen.ORDER_DETAIL -> selectedOrder?.let { order ->
            OrderDetailScreen(order = order, onBack = { screen = Screen.HOME })
        }
    }
}

/** Bottom-nav shell for the logged-in customer: Home, Macaash, Orders, Profile. */
@Composable
private fun CustomerHome(
    onOpenCompany: (Company) -> Unit,
    onOpenOrder: (CustomerOrder) -> Unit,
    onLogout: () -> Unit,
) {
    var tab by remember { mutableStateOf(HomeTab.HOME) }

    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = tab == HomeTab.HOME,
                    onClick = { tab = HomeTab.HOME },
                    icon = { Icon(Icons.Filled.Home, contentDescription = "Home") },
                    label = { Text("Home") },
                )
                NavigationBarItem(
                    selected = tab == HomeTab.MACAASH,
                    onClick = { tab = HomeTab.MACAASH },
                    icon = { Icon(Icons.Filled.CardGiftcard, contentDescription = "Macaash") },
                    label = { Text("Macaash") },
                )
                NavigationBarItem(
                    selected = tab == HomeTab.ORDERS,
                    onClick = { tab = HomeTab.ORDERS },
                    icon = { Icon(Icons.Filled.Receipt, contentDescription = "Orders") },
                    label = { Text("Orders") },
                )
                NavigationBarItem(
                    selected = tab == HomeTab.PROFILE,
                    onClick = { tab = HomeTab.PROFILE },
                    icon = { Icon(Icons.Filled.Person, contentDescription = "Profile") },
                    label = { Text("Profile") },
                )
            }
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            when (tab) {
                HomeTab.HOME -> HomeScreen(onOpenCompany = onOpenCompany, onOpenMacaash = { tab = HomeTab.MACAASH })
                HomeTab.MACAASH -> MacaashScreen()
                HomeTab.ORDERS -> OrdersScreen(onOpenOrder = onOpenOrder)
                HomeTab.PROFILE -> ProfileScreen(onLogout = onLogout)
            }
        }
    }
}
