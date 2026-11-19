package com.dalab.internet.data

/** GET /agent/company-profit: each network's Commission / Discount / Profit % and what completed orders earned. */
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
    val netCommissionPct: Double? = null,
    val orders: Int = 0,
    val sales: Double = 0.0,
    val netCommission: Double = 0.0,
    val profit: Double = 0.0,
    val total: Double = 0.0,
    val updatedAt: String? = null,
)

data class CompanyProfitTotals(
    val orders: Int = 0,
    val sales: Double = 0.0,
    val netCommission: Double = 0.0,
    val profit: Double = 0.0,
    val total: Double = 0.0,
)

/** PUT /agent/company-profit/{companyId}: an empty value clears that percentage. */
data class CompanyProfitUpdate(
    val commissionPct: String,
    val discountPct: String,
    val profitPct: String,
)
