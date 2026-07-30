package com.dalab.internet.customer.ui

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import com.dalab.internet.customer.prefs.LocalizationManager
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneOffset

/** Shared date/time picker pair for Schedule Recharge, used by both CheckoutScreen (create) and OrderDetailScreen (edit). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScheduleDatePickerDialog(
    initialDate: LocalDate?,
    onDismiss: () -> Unit,
    onDatePicked: (LocalDate) -> Unit,
) {
    val datePickerState = rememberDatePickerState(
        // DatePicker works in UTC-midnight millis regardless of device
        // timezone — only the DATE portion is taken from this picker,
        // combined with the separately-picked LOCAL wall-clock time.
        initialSelectedDateMillis = initialDate
            ?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli()
            ?: Instant.now().toEpochMilli(),
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                val millis = datePickerState.selectedDateMillis
                if (millis != null) {
                    onDatePicked(Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate())
                }
            }) { Text(LocalizationManager.tr("Next", "Xiga")) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(LocalizationManager.tr("Cancel", "Jooji")) }
        },
    ) {
        DatePicker(state = datePickerState)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScheduleTimePickerDialog(
    initialTime: LocalTime?,
    onDismiss: () -> Unit,
    onTimePicked: (LocalTime) -> Unit,
) {
    val now = LocalTime.now()
    val timePickerState = rememberTimePickerState(
        initialHour = initialTime?.hour ?: now.hour,
        initialMinute = initialTime?.minute ?: now.minute,
    )
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(LocalizationManager.tr("Choose a time", "Dooro saacadda")) },
        text = { TimePicker(state = timePickerState) },
        confirmButton = {
            TextButton(onClick = {
                onTimePicked(LocalTime.of(timePickerState.hour, timePickerState.minute))
            }) { Text(LocalizationManager.tr("Done", "Dhameystir")) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(LocalizationManager.tr("Cancel", "Jooji")) }
        },
    )
}
