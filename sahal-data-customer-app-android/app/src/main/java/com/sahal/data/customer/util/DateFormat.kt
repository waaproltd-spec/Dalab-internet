package com.sahal.data.customer.util

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

private val API_DATE_FORMATS = listOf(
    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    "yyyy-MM-dd'T'HH:mm:ss'Z'",
    "yyyy-MM-dd HH:mm:ss",
)

/**
 * Parses an API timestamp. admin-backend-ts (Postgres) returns full ISO 8601
 * ("2026-07-25T08:34:50.000Z"). Returns null (never throws) if none of the
 * known formats match, so a parsing gap is a no-op, never a crash.
 */
fun parseApiDate(raw: String?): Date? {
    if (raw.isNullOrBlank()) return null
    for (pattern in API_DATE_FORMATS) {
        try {
            val parser = SimpleDateFormat(pattern, Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
            return parser.parse(raw) ?: continue
        } catch (_: Exception) {
            continue
        }
    }
    return null
}

/**
 * Formats an API timestamp for display. Falls back to the raw string if
 * parsing fails, so a display bug is never a crash.
 */
fun formatApiDateTime(raw: String?): String {
    if (raw.isNullOrBlank()) return "—"
    val date = parseApiDate(raw) ?: return raw
    val output = SimpleDateFormat("MMM d, yyyy 'at' h:mm a", Locale.US)
    return output.format(date)
}
