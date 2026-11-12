package com.dalab.internet.data

/** GET /agent/today -- every number comes from the system's own database
 * (orders, dial attempts, commission records), for Somalia's today. */
data class AgentToday(
    val date: String = "",
    val timezone: String = "",
    val ordersToday: DayOrderCounts = DayOrderCounts(),
    val myPerformance: MyDayPerformance = MyDayPerformance(),
    val revenueToday: DayRevenue = DayRevenue(),
    val generatedAt: String? = null,
)

/** Orders created today. completed + pending + failed + cancelled = created. */
data class DayOrderCounts(
    val created: Int = 0,
    val completed: Int = 0,
    val pending: Int = 0,
    val failed: Int = 0,
    val cancelled: Int = 0,
)

/** This agent's own day: orders they created or dialed, and their USSD dials. */
data class MyDayPerformance(
    val created: Int = 0,
    val completed: Int = 0,
    val pending: Int = 0,
    val failed: Int = 0,
    val cancelled: Int = 0,
    val dialAttempts: Int = 0,
    val dialSuccess: Int = 0,
    val dialFailed: Int = 0,
    val dialPending: Int = 0,
)

/** Completed transaction volume and commission, kept separate. */
data class DayRevenue(
    val completedVolume: Double = 0.0,
    val commission: Double = 0.0,
    val myCompletedVolume: Double = 0.0,
    val myCommission: Double = 0.0,
)

/** GET /agent/notices -- an admin's Maintenance Notice. phase is
 * "active" (show now) or "scheduled" (starts later). Times are ISO-8601. */
data class AgentNotice(
    val id: String,
    val title: String,
    val message: String,
    val kind: String = "maintenance",
    val startsAt: String? = null,
    val endsAt: String? = null,
    val phase: String = "active",
)
