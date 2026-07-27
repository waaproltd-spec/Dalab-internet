package com.dalab.internet.customer.data

import com.dalab.internet.customer.R

/**
 * Bundled per-provider logo assets, matched by Company.id (the lowercase ids
 * seeded in admin-backend-ts/src/db/seed.ts: hormuud/somnet/somtel/amtel).
 * Returns null for any company without a bundled logo (e.g. a newly added
 * provider) — callers fall back to the colored-initial placeholder in that case.
 */
fun companyLogoRes(companyId: String): Int? = when (companyId.lowercase()) {
    "hormuud" -> R.drawable.logo_hormuud
    "somnet" -> R.drawable.logo_somnet
    "somtel" -> R.drawable.logo_somtel
    "amtel" -> R.drawable.logo_amtel
    else -> null
}
