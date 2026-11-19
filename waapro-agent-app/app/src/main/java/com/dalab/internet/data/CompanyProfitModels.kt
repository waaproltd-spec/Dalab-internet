package com.dalab.internet.data

/** GET /agent/company-profit: each network's Commission % and Discount % (Profit % = Commission - Discount) over its successful orders. */
data class CompanyProfitOverview(
    val period: String = "month",
    val companies: List<CompanyProfitRow> = emptyList(),
    val totals: CompanyProfitTotals = CompanyProfitTotals(),
)

data class CompanyProfitRow(
    val companyId: String = "",
    val name: String = "",
    val colorHex: String? = null,
    val status: String? = null,
    val configured: Boolean = false,
    val commissionPct: Double? = null,
    val discountPct: Double? = null,
    val profitPct: Double? = null,
    val orders: Int = 0,
    val sales: Double = 0.0,
    // What was actually sent to the network (the commission base).
    val sentAmount: Double = 0.0,
    val commission: Double = 0.0,
    val discount: Double = 0.0,
    val profit: Double = 0.0,
    val updatedAt: String? = null,
)

data class CompanyProfitTotals(
    val orders: Int = 0,
    val sales: Double = 0.0,
    val sentAmount: Double = 0.0,
    val commission: Double = 0.0,
    val discount: Double = 0.0,
    val profit: Double = 0.0,
)

/** PUT /agent/company-profit/{companyId}: Commission and Discount (Profit = Commission - Discount). An empty commission clears the network. */
data class CompanyProfitUpdate(
    val commissionPct: String,
    val discountPct: String,
)
