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

/** GET /agent/agents -- the other active agents of this system. phone is
 * null when the system hides work numbers (phoneVisible = false). */
data class OtherAgentsResponse(
    val agents: List<OtherAgent> = emptyList(),
    val phoneVisible: Boolean = false,
    val onlineWindowSeconds: Int = 180,
    val onlineCount: Int = 0,
    val serverTime: String? = null,
)

data class OtherAgent(
    val id: String,
    val name: String,
    val phone: String? = null,
    val online: Boolean = false,
    val status: String = "OFFLINE",
    val lastSeenAt: String? = null,
)

/** GET /agent/sim-balances -- every admin-configured SIM, separately. */
data class SimBalancesResponse(
    val sims: List<SimBalance> = emptyList(),
    val staleHours: Int = 24,
    val generatedAt: String? = null,
)

/** One SIM's balance. balance is null when there's no confirmed balance;
 * status/message then say why (never a made-up 0). status: ok |
 * no_balance_yet | sim_missing | device_offline | stale. */
data class SimBalance(
    val id: String,
    val providerKey: String,
    val label: String,
    val network: String,
    val phoneNumber: String? = null,
    val deviceId: String? = null,
    val deviceName: String? = null,
    val simSlot: Int = 1,
    val balance: Double? = null,
    val updatedAt: String? = null,
    val source: String? = null,
    val status: String = "ok",
    val message: String? = null,
)
