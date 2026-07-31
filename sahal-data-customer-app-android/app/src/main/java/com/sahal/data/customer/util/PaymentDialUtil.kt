package com.sahal.data.customer.util

import android.content.Intent
import android.net.Uri
import com.sahal.data.customer.data.PaymentWallet
import com.sahal.data.customer.network.ApiClient

/**
 * Shared by CheckoutScreen (pay-now) and OrderDetailScreen (pay-later, once
 * a scheduled order becomes due) so both screens resolve a wallet's dial
 * string identically and can never drift out of sync.
 */
object PaymentDialUtil {
    /**
     * Re-fetches the wallet fresh rather than trusting a possibly-stale copy
     * — a Super Admin change (payment number, dial prefix) must still take
     * effect. The payment number is always the WALLET's OWN provider's
     * number (server-joined via payment_wallets.company_id), independent of
     * which company's package is being purchased — cross-provider payment
     * (pay via one telecom, buy from another) is intentional. Returns null
     * if no payment number is configured for this wallet's provider.
     */
    suspend fun resolveDialIntent(wallet: PaymentWallet, amount: Double): Intent? {
        val freshWallet = try {
            ApiClient.service.getPaymentWallets().body()?.firstOrNull { it.id == wallet.id }
        } catch (e: Exception) {
            null
        }
        val prefix = freshWallet?.dialPrefix ?: wallet.dialPrefix
        val payNumber = freshWallet?.paymentNumber?.takeIf { it.isNotBlank() }
            ?: wallet.paymentNumber?.takeIf { it.isNotBlank() }
            ?: return null
        val dialTarget = "*$prefix*$payNumber*${"%.2f".format(amount)}#"
        return Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(dialTarget)))
    }
}
