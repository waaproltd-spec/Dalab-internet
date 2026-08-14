package com.dalab.internet.customer.ui

import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.data.FeedbackCategory
import com.dalab.internet.customer.data.FeedbackRequest
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.UpdateProfilePhotoRequest
import com.dalab.internet.customer.prefs.LocalizationManager
import kotlinx.coroutines.launch

private val DarkNavy = Color(0xFF0B1240)
private val DalabGreen2 = Color(0xFF16A34A)

/**
 * Send feedback / report an issue. Reuses the exact same avatar card as
 * [ProfileScreen] (see [ProfileAvatarCard]) per the new design, including
 * live photo upload from this screen too. category options mirror the
 * backend's exact, validated enum (feedback.routes.ts FEEDBACK_CATEGORIES /
 * see [FeedbackCategory]) one-for-one -- no duplicates, no options the
 * server would reject.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedbackScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val compact = LocalConfiguration.current.screenHeightDp < 700

    var customer by remember { mutableStateOf(SessionManager.currentCustomer()) }
    var photoUploading by remember { mutableStateOf(false) }
    var photoError by remember { mutableStateOf<String?>(null) }

    var selectedCategory by remember { mutableStateOf<FeedbackCategory?>(null) }
    var message by remember { mutableStateOf("") }
    var showIssueSheet by remember { mutableStateOf(false) }
    var categoryError by remember { mutableStateOf<String?>(null) }
    var messageError by remember { mutableStateOf<String?>(null) }
    var submitting by remember { mutableStateOf(false) }
    var submitError by remember { mutableStateOf<String?>(null) }
    var submitted by remember { mutableStateOf(false) }

    val photoPickerLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        photoError = null
        photoUploading = true
        scope.launch {
            try {
                val mimeType = context.contentResolver.getType(uri) ?: "image/jpeg"
                val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                when {
                    bytes == null -> photoError = "Couldn't read that photo. Please try another."
                    bytes.size > 4 * 1024 * 1024 -> photoError = "Photo is too large (max 4MB)."
                    else -> {
                        val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                        val response = ApiClient.service.uploadProfilePhoto(
                            UpdateProfilePhotoRequest("data:$mimeType;base64,$base64")
                        )
                        val updated = response.body()
                        if (updated != null) {
                            customer = updated
                            SessionManager.updateProfile(updated)
                        } else {
                            photoError = "Couldn't update your photo. Please try again."
                        }
                    }
                }
            } catch (_: Exception) {
                photoError = "Couldn't reach the server. Check your connection."
            }
            photoUploading = false
        }
    }

    val photoBitmap = remember(customer?.photoBase64) {
        customer?.photoBase64?.let { dataUri ->
            try {
                val encoded = dataUri.substringAfter(",", "")
                if (encoded.isEmpty()) null else {
                    val bytes = Base64.decode(encoded, Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
                }
            } catch (_: Exception) {
                null
            }
        }
    }

    LaunchedEffect(Unit) {
        try {
            ApiClient.service.getProfile().body()?.let {
                customer = it
                SessionManager.updateProfile(it)
            }
        } catch (_: Exception) {
            // Keep whatever was last known locally.
        }
    }

    fun submit() {
        val category = selectedCategory
        val trimmedMessage = message.trim()
        categoryError = if (category == null) "Please select an issue" else null
        messageError = if (trimmedMessage.isEmpty()) "Please write your feedback" else null
        if (category == null || trimmedMessage.isEmpty()) return

        submitError = null
        submitting = true
        scope.launch {
            try {
                @Suppress("DEPRECATION")
                val deviceInfo = "Android ${Build.VERSION.RELEASE}; ${Build.MANUFACTURER} ${Build.MODEL}"
                val response = ApiClient.service.submitFeedback(
                    FeedbackRequest(category = category.apiValue, message = trimmedMessage, deviceInfo = deviceInfo)
                )
                if (response.isSuccessful) {
                    submitted = true
                } else {
                    submitError = "Couldn't submit your feedback. Please try again."
                }
            } catch (_: Exception) {
                submitError = "Couldn't reach the server. Check your connection."
            }
            submitting = false
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        LocalizationManager.tr("Feedback", "Fikrad"),
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = DarkNavy),
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
        ) {
            if (submitted) {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(32.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Spacer(Modifier.height(40.dp))
                    Box(
                        modifier = Modifier.size(64.dp).background(Color(0xFFE4F7EA), CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = DalabGreen2, modifier = Modifier.size(34.dp))
                    }
                    Spacer(Modifier.height(16.dp))
                    Text(
                        LocalizationManager.tr("Thanks for your feedback", "Waad ku mahadsan tahay ra'yigaaga"),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.height(6.dp))
                    Text(
                        LocalizationManager.tr("Our team will review it shortly.", "Kooxdayadu waxay dib u eegi doontaa dhawaan."),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.height(24.dp))
                    OutlinedButton(onClick = onBack) {
                        Text(LocalizationManager.tr("Done", "Dhammaystir"))
                    }
                }
                return@Column
            }

            ProfileAvatarCard(
                customer = customer,
                photoBitmap = photoBitmap,
                photoUploading = photoUploading,
                photoError = photoError,
                compact = compact,
                onPickPhoto = { photoPickerLauncher.launch("image/*") },
            )

            Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                Surface(
                    shape = RoundedCornerShape(14.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { showIssueSheet = true },
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 16.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            selectedCategory?.let { LocalizationManager.tr(it.label, it.labelSo) }
                                ?: LocalizationManager.tr("Select title", "Dooro cinwaanka"),
                            color = if (selectedCategory != null) {
                                MaterialTheme.colorScheme.onSurface
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                        Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (categoryError != null) {
                    Text(
                        categoryError!!,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(top = 4.dp, start = 4.dp),
                    )
                }

                Spacer(Modifier.height(14.dp))

                OutlinedTextField(
                    value = message,
                    onValueChange = { message = it; if (it.isNotBlank()) messageError = null },
                    placeholder = { Text(LocalizationManager.tr("Please write your feedback", "Fadlan qor ra'yigaaga")) },
                    isError = messageError != null,
                    modifier = Modifier.fillMaxWidth().height(180.dp),
                )
                if (messageError != null) {
                    Text(
                        messageError!!,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(top = 4.dp, start = 4.dp),
                    )
                }

                Spacer(Modifier.height(20.dp))

                Button(
                    onClick = { submit() },
                    enabled = !submitting,
                    shape = RoundedCornerShape(28.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = DarkNavy),
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                ) {
                    if (submitting) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = Color.White)
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(if (submitting) LocalizationManager.tr("Submitting...", "Waa la gudbinayaa...") else LocalizationManager.tr("Submit", "Gudbi"))
                }

                if (submitError != null) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        submitError!!,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                Spacer(Modifier.height(24.dp))
            }
        }
    }

    if (showIssueSheet) {
        ModalBottomSheet(onDismissRequest = { showIssueSheet = false }) {
            Column(modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                Text(
                    LocalizationManager.tr("Select Issue", "Dooro Dhibaatada"),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                )
                Divider()
                // The full, deduplicated backend enum -- exactly once each.
                FeedbackCategory.entries.forEach { category ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                selectedCategory = category
                                categoryError = null
                                showIssueSheet = false
                            }
                            .padding(horizontal = 20.dp, vertical = 16.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(LocalizationManager.tr(category.label, category.labelSo))
                        RadioButton(selected = selectedCategory == category, onClick = {
                            selectedCategory = category
                            categoryError = null
                            showIssueSheet = false
                        })
                    }
                    Divider()
                }
            }
        }
    }
}
