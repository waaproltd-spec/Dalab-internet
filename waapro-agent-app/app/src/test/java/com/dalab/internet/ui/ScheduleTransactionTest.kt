package com.dalab.internet.ui

import com.dalab.internet.data.Order
import com.dalab.internet.data.OrderStatus
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant

class ScheduleTransactionTest {
    private fun order(status: OrderStatus, scheduledAt: String?, paidAt: String? = null) = Order(
        id = "DLB1", customerName = "Abdirizak Mohamed", customerPhone = "617076136", companyId = "hormuud",
        companyName = "Hormuud", packageName = "Anfac", amount = 0.09, status = status,
        senderPhone = "617076136", receiverPhone = "617076136", paymentMethod = null,
        createdAt = "2026-11-17T07:00:00Z", scheduledAt = scheduledAt, scheduledPaidAt = paidAt,
    )
    private val now = Instant.parse("2026-11-17T07:40:00Z")

    @Test
    fun timesAreShownInMogadishuTime() {
        // 07:45 UTC is 10:45 AM in Mogadishu (UTC+3).
        assertEquals("17/11/2026 10:45 AM", scheduleTimeText("2026-11-17T07:45:00Z"))
    }

    @Test
    fun stateFollowsPaymentAndTime() {
        assertEquals("Waiting for payment", scheduleState(order(OrderStatus.PENDING, "2026-11-17T07:45:00Z"), now).label)
        assertEquals("Paid · waiting for its time", scheduleState(order(OrderStatus.PENDING, "2026-11-17T07:45:00Z", "2026-11-17T07:30:00Z"), now).label)
        assertEquals("Time reached · waiting for payment", scheduleState(order(OrderStatus.PENDING, "2026-11-17T07:35:00Z"), now).label)
        assertEquals("Sending now", scheduleState(order(OrderStatus.IN_PROGRESS, "2026-11-17T07:35:00Z"), now).label)
        assertEquals("Sent", scheduleState(order(OrderStatus.COMPLETED, "2026-11-17T07:35:00Z"), now).label)
    }
}
