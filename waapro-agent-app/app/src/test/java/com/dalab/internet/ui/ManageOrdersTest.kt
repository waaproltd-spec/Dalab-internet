package com.dalab.internet.ui

import com.dalab.internet.data.Order
import com.dalab.internet.data.OrderStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ManageOrdersTest {
    private val order = Order(
        id = "DLB1234",
        customerName = "Cali Axmed",
        customerPhone = "+252 61 555 1234",
        companyId = "hormuud",
        companyName = "Hormuud",
        packageName = "Unlimited Day",
        amount = 1.5,
        status = OrderStatus.PENDING,
        senderPhone = "0615559999",
        receiverPhone = null,
        paymentMethod = "evc",
        createdAt = "2026-11-12T10:00:00Z",
    )

    @Test fun blankSearchMatchesEverything() = assertTrue(orderMatches(order, "  "))

    @Test fun matchesReferenceNameAndPackage() {
        assertTrue(orderMatches(order, "dlb12"))
        assertTrue(orderMatches(order, "cali"))
        assertTrue(orderMatches(order, "unlimited"))
    }

    @Test fun matchesNumbersWhateverTheSpacing() {
        assertTrue(orderMatches(order, "615551234"))
        assertTrue(orderMatches(order, "9999"))
        assertFalse(orderMatches(order, "777888"))
    }

    @Test fun filtersAskTheServerForTheRightStatus() {
        assertEquals(
            listOf("pending", "in_progress", "failed", "completed", "cancelled"),
            ManageOrdersFilter.values().map { it.status },
        )
    }
}
