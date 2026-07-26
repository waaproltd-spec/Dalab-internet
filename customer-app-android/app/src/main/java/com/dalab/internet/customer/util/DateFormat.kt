package com.dalab.internet.customer.util

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Formats an API timestamp for display. admin-backend-ts (Postgres) returns
 * full ISO 8601 ("2026-07-25T08:34:50.000Z"). Falls back to the raw string
 * if parsing fails, so a display bug is never a crash.
 */
fun formatApiDateTime(raw: String?): String {
    if (raw.isNullOrBlank()) return "—"

    val inputFormats = listOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd HH:mm:ss",
    )
    for (pattern in inputFormats) {
        try {
            val parser = SimpleDateFormat(pattern, Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
            val date = parser.parse(raw) ?: continue
            val output = SimpleDateFormat("MMM d, yyyy 'at' h:mm a", Locale.US)
            return output.format(date)
        } catch (_: Exception) {
            continue
        }
    }
    return raw // never crash the UI over a date string we couldn't parse
}
