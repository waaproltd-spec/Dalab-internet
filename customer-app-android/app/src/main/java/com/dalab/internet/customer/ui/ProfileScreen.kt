package com.dalab.internet.customer.ui

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.GetApp
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Feedback
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.data.CustomerProfile
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.PinBody
import com.dalab.internet.customer.network.ReferralInfo
import com.dalab.internet.customer.network.SocialLinks
import com.dalab.internet.customer.network.UpdateProfilePhotoRequest
import com.dalab.internet.customer.network.UpdateProfileRequest
import com.dalab.internet.customer.prefs.LocalizationManager
import kotlinx.coroutines.launch

private val HeaderStart = Color(0xFF1D2E8C)
private val HeaderEnd = Color(0xFF16A34A)
private val DangerRed = Color(0xFFDC2626)
private val DalabGreen = Color(0xFF16A34A)
private const val PACKAGE_NAME = "com.dalab.internet.customer"

@Composable
fun ProfileScreen(onLogout: () -> Unit, onOpenFeedback: () -> Unit) {
    val context = LocalContext.current
    var customer by remember { mutableStateOf(SessionManager.currentCustomer()) }
    var showEditDialog by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    var showPinDialog by remember { mutableStateOf(false) }
    // Optional login PIN — entirely separate from the required phone+OTP
    // flow. isPinSet drives whether the menu row/dialog offer "Create" or
    // "Change / Remove"; refreshed from the server in case it was reset by
    // Support since this session started.
    var isPinSet by remember { mutableStateOf(SessionManager.isPinSet()) }
    var contentVisible by remember { mutableStateOf(false) }
    var referralInfo by remember { mutableStateOf<ReferralInfo?>(null) }
    var showReferralHistory by remember { mutableStateOf(false) }
    var socialLinks by remember { mutableStateOf(SocialLinks()) }
    // Profile-photo upload — never routed through SessionManager (which
    // persists only id/name/phone to small EncryptedSharedPreferences
    // values); the photo itself lives only in this screen's own Compose
    // state, re-fetched fresh via getProfile() every time the tab opens.
    var photoUploading by remember { mutableStateOf(false) }
    var photoError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val compact = LocalConfiguration.current.screenHeightDp < 700

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
                    // Mirrors the 4MB cap PUT /customer/profile/photo enforces
                    // server-side -- checked here too so a customer on a slow
                    // connection finds out immediately instead of waiting on
                    // a round trip just to get the same rejection back.
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

    // Decoded once per distinct photoBase64 value, not on every recomposition.
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
        contentVisible = true
        try {
            // Refreshes name + photo from the server -- SessionManager's cached
            // copy (used as this screen's initial state above) never holds a
            // photo at all, so this is the only place photoBase64 is ever
            // populated.
            ApiClient.service.getProfile().body()?.let {
                customer = it
                SessionManager.updateProfile(it)
            }
        } catch (_: Exception) {
            // Keep whatever was last known locally — not worth surfacing an error for.
        }
        try {
            ApiClient.service.getPinStatus().body()?.let {
                isPinSet = it.isSet
                SessionManager.updatePinSet(it.isSet)
            }
        } catch (_: Exception) {
            // Keep whatever was last known locally — not worth surfacing an error for.
        }
        try {
            referralInfo = ApiClient.service.getReferralInfo().body()
        } catch (_: Exception) {
            // Loyalty Points card just stays hidden until the next visit — not worth an error dialog.
        }
        try {
            ApiClient.service.getPublicSettings().body()?.let { socialLinks = it.socialLinks }
        } catch (_: Exception) {
            // Follow Us section just stays hidden until the next visit — not worth an error dialog.
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState()),
    ) {
            ProfileAvatarCard(
                customer = customer,
                photoBitmap = photoBitmap,
                photoUploading = photoUploading,
                photoError = photoError,
                compact = compact,
                onPickPhoto = { photoPickerLauncher.launch("image/*") },
                nameModifier = Modifier.clickable { showEditDialog = true },
            )

            AnimatedVisibility(
                visible = contentVisible,
                enter = fadeIn(tween(350)) + slideInVertically(tween(350)) { it / 10 },
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    referralInfo?.let { info ->
                        LoyaltyPointsCard(
                            info = info,
                            onShare = {
                                val shareIntent = Intent(Intent.ACTION_SEND).apply {
                                    type = "text/plain"
                                    putExtra(
                                        Intent.EXTRA_TEXT,
                                        "Join me on DALAB Internet and get fast, reliable data packages! Sign up with my referral link: ${info.referralLink}",
                                    )
                                }
                                context.startActivity(Intent.createChooser(shareIntent, "Share your referral link"))
                            },
                            onCopy = {
                                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                clipboard.setPrimaryClip(ClipData.newPlainText("Referral link", info.referralLink))
                            },
                            onViewHistory = { showReferralHistory = true },
                        )
                        Spacer(Modifier.height(16.dp))
                    }
                    Surface(
                        shape = RoundedCornerShape(20.dp),
                        color = MaterialTheme.colorScheme.surface,
                        modifier = Modifier.fillMaxWidth().shadow(3.dp, RoundedCornerShape(20.dp)),
                    ) {
                        Column(modifier = Modifier.padding(vertical = 4.dp)) {
                            ProfileMenuRow(
                                icon = Icons.Filled.Lock,
                                label = if (isPinSet) {
                                    LocalizationManager.tr("Login PIN", "PIN-ka Gelitaanka")
                                } else {
                                    LocalizationManager.tr("Create Login PIN", "Samee PIN Gelitaan")
                                },
                                onClick = { showPinDialog = true },
                            )
                            ProfileMenuRow(
                                icon = Icons.Filled.Feedback,
                                label = LocalizationManager.tr("Feedback", "Fikrad"),
                                onClick = onOpenFeedback,
                            )
                            ProfileMenuRow(
                                icon = Icons.Filled.Star,
                                label = LocalizationManager.tr("Rate the App", "Qiimee Barnaamijka"),
                                onClick = {
                                    try {
                                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$PACKAGE_NAME")))
                                    } catch (_: ActivityNotFoundException) {
                                        context.startActivity(
                                            Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$PACKAGE_NAME"))
                                        )
                                    }
                                },
                                showDivider = false,
                            )
                        }
                    }

                    Spacer(Modifier.height(16.dp))
                    DangerActionCard(
                        icon = Icons.Filled.Logout,
                        label = LocalizationManager.tr("Log Out", "Ka Bax"),
                        onClick = onLogout,
                    )
                    Spacer(Modifier.height(12.dp))
                    DangerActionCard(
                        icon = Icons.Filled.Delete,
                        label = LocalizationManager.tr("Delete Account", "Tirtir Xisaabta"),
                        onClick = { showDeleteConfirm = true },
                    )
                    Spacer(Modifier.height(20.dp))
                    FollowUsSection(context = context, links = socialLinks)
                    Spacer(Modifier.height(18.dp))
                    PoweredBySection()
                    Spacer(Modifier.height(16.dp))
                }
            }
        }

    if (showEditDialog) {
        var draftName by remember { mutableStateOf(customer?.name ?: "") }
        var saving by remember { mutableStateOf(false) }
        var error by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { if (!saving) showEditDialog = false },
            title = { Text("Edit Profile") },
            text = {
                Column {
                    OutlinedTextField(
                        value = draftName,
                        onValueChange = { draftName = it },
                        label = { Text("Your name") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (error != null) {
                        Spacer(Modifier.height(8.dp))
                        Text(error!!, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = draftName.isNotBlank() && !saving,
                    onClick = {
                        error = null
                        saving = true
                        scope.launch {
                            try {
                                val response = ApiClient.service.updateProfile(UpdateProfileRequest(draftName.trim()))
                                val updated = response.body()
                                if (updated != null) {
                                    SessionManager.updateProfile(updated)
                                    customer = updated
                                    showEditDialog = false
                                } else {
                                    error = "Couldn't save. Please try again."
                                }
                            } catch (_: Exception) {
                                error = "Couldn't reach the server. Check your connection."
                            }
                            saving = false
                        }
                    },
                ) {
                    Text(if (saving) "Saving..." else "Save")
                }
            },
            dismissButton = {
                TextButton(onClick = { showEditDialog = false }, enabled = !saving) { Text("Cancel") }
            },
        )
    }

    if (showDeleteConfirm) {
        var deleting by remember { mutableStateOf(false) }
        var deleteError by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { if (!deleting) showDeleteConfirm = false },
            title = { Text("Delete Account?") },
            text = {
                Column {
                    Text("This permanently deletes your DALAB Internet account. This cannot be undone.")
                    if (deleteError != null) {
                        Spacer(Modifier.height(8.dp))
                        Text(deleteError!!, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !deleting,
                    onClick = {
                        deleteError = null
                        deleting = true
                        scope.launch {
                            try {
                                val response = ApiClient.service.deleteAccount()
                                if (response.isSuccessful) {
                                    showDeleteConfirm = false
                                    onLogout()
                                } else {
                                    deleteError = "Couldn't delete your account. Please try again or contact support."
                                }
                            } catch (_: Exception) {
                                deleteError = "Couldn't reach the server. Check your connection."
                            }
                            deleting = false
                        }
                    },
                ) {
                    Text(if (deleting) "Deleting..." else "Delete", color = DangerRed)
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }, enabled = !deleting) { Text("Cancel") }
            },
        )
    }

    if (showPinDialog) {
        var newPin by remember { mutableStateOf("") }
        var confirmPin by remember { mutableStateOf("") }
        var saving by remember { mutableStateOf(false) }
        var pinError by remember { mutableStateOf<String?>(null) }

        fun closeDialog() {
            showPinDialog = false
            newPin = ""
            confirmPin = ""
            pinError = null
        }

        AlertDialog(
            onDismissRequest = { if (!saving) closeDialog() },
            title = { Text(if (isPinSet) "Change Login PIN" else "Create Login PIN") },
            text = {
                Column {
                    Text(
                        "Optional: after entering your OTP code, you'll also be asked for this PIN. Leave it unset and login stays exactly as it is today.",
                        fontSize = 12.5.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = newPin,
                        onValueChange = { if (it.length <= 8 && it.all(Char::isDigit)) newPin = it },
                        label = { Text("New PIN (3-8 digits)") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = confirmPin,
                        onValueChange = { if (it.length <= 8 && it.all(Char::isDigit)) confirmPin = it },
                        label = { Text("Confirm PIN") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (pinError != null) {
                        Spacer(Modifier.height(8.dp))
                        Text(pinError!!, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
                    }
                    if (isPinSet) {
                        Spacer(Modifier.height(12.dp))
                        TextButton(
                            enabled = !saving,
                            onClick = {
                                pinError = null
                                saving = true
                                scope.launch {
                                    try {
                                        val response = ApiClient.service.removePin()
                                        if (response.isSuccessful) {
                                            isPinSet = false
                                            SessionManager.updatePinSet(false)
                                            closeDialog()
                                        } else {
                                            pinError = "Couldn't remove your PIN. Please try again."
                                        }
                                    } catch (_: Exception) {
                                        pinError = "Couldn't reach the server. Check your connection."
                                    }
                                    saving = false
                                }
                            },
                        ) {
                            Text("Remove PIN", color = DangerRed)
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !saving && newPin.length >= 3 && newPin == confirmPin,
                    onClick = {
                        pinError = null
                        if (newPin != confirmPin) {
                            pinError = "PINs don't match."
                            return@TextButton
                        }
                        saving = true
                        scope.launch {
                            try {
                                val response = ApiClient.service.setPin(PinBody(newPin))
                                if (response.isSuccessful) {
                                    isPinSet = true
                                    SessionManager.updatePinSet(true)
                                    closeDialog()
                                } else {
                                    pinError = "PIN must be 3-8 digits."
                                }
                            } catch (_: Exception) {
                                pinError = "Couldn't reach the server. Check your connection."
                            }
                            saving = false
                        }
                    },
                ) {
                    Text(if (saving) "Saving..." else "Save")
                }
            },
            dismissButton = {
                TextButton(onClick = { closeDialog() }, enabled = !saving) { Text("Cancel") }
            },
        )
    }

    if (showReferralHistory) {
        AlertDialog(
            onDismissRequest = { showReferralHistory = false },
            title = { Text(LocalizationManager.tr("Referral History", "Taariikhda Wadaagida")) },
            text = {
                val entries = referralInfo?.referrals.orEmpty()
                if (entries.isEmpty()) {
                    Text(
                        LocalizationManager.tr(
                            "No one has joined with your referral link yet.",
                            "Wali qofna ma isticmaalin xiriirkaaga wadaagida.",
                        ),
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                        entries.forEach { entry ->
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(entry.name?.takeIf { it.isNotBlank() } ?: entry.phone, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                                    Text(entry.phone, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                Text(
                                    if (entry.hasCompletedPurchase) {
                                        LocalizationManager.tr("Purchased", "Wax soo iibsaday")
                                    } else {
                                        LocalizationManager.tr("Joined", "Ku biiray")
                                    },
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = if (entry.hasCompletedPurchase) HeaderEnd else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Divider()
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showReferralHistory = false }) { Text("Close") }
            },
        )
    }
}

/** Loyalty Points summary card: balance, referral link (share/copy), earned
 * vs. used, and an entry point into the full referral history dialog.
 * Reuses the existing Macaash balance/ledger server-side — this card is
 * purely a presentation layer over GET /customers/me/referral. */
@Composable
private fun LoyaltyPointsCard(info: ReferralInfo, onShare: () -> Unit, onCopy: () -> Unit, onViewHistory: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().shadow(3.dp, RoundedCornerShape(20.dp)),
    ) {
        Column(modifier = Modifier.padding(18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(HeaderEnd.copy(alpha = 0.14f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.CardGiftcard, contentDescription = null, tint = HeaderEnd, modifier = Modifier.size(18.dp))
                }
                Spacer(Modifier.width(12.dp))
                Text(
                    LocalizationManager.tr("Loyalty Points", "Dhibcaha Daacadnimada"),
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                )
            }
            Spacer(Modifier.height(14.dp))
            Text("${info.pointsBalance}", fontWeight = FontWeight.Bold, fontSize = 30.sp, color = HeaderEnd)
            Text(
                LocalizationManager.tr("points available", "dhibco diyaar ah"),
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(14.dp))
            Row(modifier = Modifier.fillMaxWidth()) {
                LoyaltyStat(
                    label = LocalizationManager.tr("Earned", "La helay"),
                    value = "${info.pointsEarnedFromReferrals}",
                    modifier = Modifier.weight(1f),
                )
                LoyaltyStat(
                    label = LocalizationManager.tr("Used for discounts", "Loo isticmaalay dhimis"),
                    value = "${info.pointsUsedForDiscounts}",
                    modifier = Modifier.weight(1f),
                )
                LoyaltyStat(
                    label = LocalizationManager.tr("Referred", "La wadaagay"),
                    value = "${info.referrals.size}",
                    modifier = Modifier.weight(1f),
                )
            }
            Spacer(Modifier.height(14.dp))
            Text(
                LocalizationManager.tr("Your referral link", "Xiriirkaaga wadaagida"),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(HeaderEnd.copy(alpha = 0.08f))
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(info.referralCode, modifier = Modifier.weight(1f), fontWeight = FontWeight.Bold, fontSize = 14.sp)
                IconButton(onClick = onCopy, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Filled.ContentCopy, contentDescription = "Copy", tint = HeaderEnd, modifier = Modifier.size(18.dp))
                }
                Spacer(Modifier.width(4.dp))
                IconButton(onClick = onShare, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Filled.Share, contentDescription = "Share", tint = HeaderEnd, modifier = Modifier.size(18.dp))
                }
            }
            Spacer(Modifier.height(10.dp))
            TextButton(onClick = onViewHistory, modifier = Modifier.fillMaxWidth()) {
                Text(LocalizationManager.tr("View Referral History", "Eeg Taariikhda Wadaagida"))
            }
        }
    }
}

@Composable
private fun LoyaltyStat(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, fontWeight = FontWeight.Bold, fontSize = 16.sp)
        Text(label, fontSize = 10.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

/**
 * "Follow us on social media" — a green header bar over a grid of round icon
 * buttons. Every destination here is driven entirely by GET /settings/public
 * (Super Admin: Settings -> Social Media Links) — a link that's unconfigured
 * or switched off there is simply absent from [links], so its button never
 * renders at all rather than guessing a URL or showing a dead "coming soon"
 * state. "Share" is the one generic, always-available action (a plain
 * Android share intent, not tied to any configured link).
 */
@Composable
private fun FollowUsSection(context: Context, links: SocialLinks) {
    data class SocialAction(
        val icon: ImageVector? = null,
        val label: String? = null,
        val contentDescription: String,
        val onClick: () -> Unit,
    )

    val actions = buildList {
        links.whatsappNumber?.let { number ->
            add(SocialAction(icon = Icons.Filled.Chat, contentDescription = "WhatsApp") {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/${number.filter(Char::isDigit)}")))
            })
        }
        links.phoneNumber?.let { number ->
            add(SocialAction(icon = Icons.Filled.Call, contentDescription = "Call") {
                context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$number")))
            })
        }
        links.facebookUrl?.let { url ->
            add(SocialAction(label = "f", contentDescription = "Facebook") {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            })
        }
        links.instagramUrl?.let { url ->
            add(SocialAction(icon = Icons.Filled.CameraAlt, contentDescription = "Instagram") {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            })
        }
        links.tiktokUrl?.let { url ->
            add(SocialAction(icon = Icons.Filled.MusicNote, contentDescription = "TikTok") {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            })
        }
        links.email?.let { address ->
            add(SocialAction(icon = Icons.Filled.Email, contentDescription = "Email") {
                context.startActivity(Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:$address")))
            })
        }
        links.playStoreUrl?.let { url ->
            add(SocialAction(icon = Icons.Filled.GetApp, contentDescription = "Play Store") {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            })
        }
        add(SocialAction(icon = Icons.Filled.Share, contentDescription = "Share") {
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(
                    Intent.EXTRA_TEXT,
                    "Check out DALAB Internet: ${links.playStoreUrl ?: "https://play.google.com/store/apps/details?id=$PACKAGE_NAME"}",
                )
            }
            context.startActivity(Intent.createChooser(shareIntent, "Share DALAB Internet"))
        })
    }

    // Share is always present, so this only happens if the backend call
    // itself failed (offline, cold-starting server) — nothing to render yet.
    if (actions.size <= 1) return

    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().shadow(3.dp, RoundedCornerShape(20.dp)),
    ) {
        Column {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp))
                    .background(DalabGreen)
                    .padding(horizontal = 18.dp, vertical = 14.dp),
            ) {
                Text(
                    LocalizationManager.tr("Follow us on social media", "Nagala soco baraha bulshada"),
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp,
                )
            }
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                actions.chunked(3).forEach { rowActions ->
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                        rowActions.forEach { action ->
                            SocialIconButton(
                                icon = action.icon,
                                label = action.label,
                                contentDescription = action.contentDescription,
                                onClick = action.onClick,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SocialIconButton(
    icon: ImageVector? = null,
    label: String? = null,
    contentDescription: String,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(48.dp)
            .clip(CircleShape)
            .border(1.5.dp, DalabGreen, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = contentDescription, tint = DalabGreen, modifier = Modifier.size(22.dp))
        } else if (label != null) {
            Text(label, color = DalabGreen, fontWeight = FontWeight.Black, fontSize = 18.sp)
        }
    }
}

/** Text-only wordmark — no logo asset provided, so styled the same way BrandHeader renders "DALAB" / "INTERNET" without an image. */
@Composable
private fun PoweredBySection() {
    Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            LocalizationManager.tr("Powered by", "Waxaa maamula"),
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            "WAAPROLTD",
            fontSize = 16.sp,
            fontWeight = FontWeight.Black,
            color = HeaderStart,
            letterSpacing = 1.sp,
        )
    }
}

/** A full-width light-red card for a destructive action (Log Out / Delete Account), shown directly in the menu — no extra tap through a popup. */
@Composable
private fun DangerActionCard(icon: ImageVector, label: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(DangerRed.copy(alpha = 0.10f))
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(DangerRed.copy(alpha = 0.16f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = DangerRed, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.width(16.dp))
        Text(label, modifier = Modifier.weight(1f), fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = DangerRed)
        Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = DangerRed)
    }
}

/**
 * The avatar (photo or generic person icon, with the green photo-edit badge)
 * + name + phone card shared by [ProfileScreen] and [FeedbackScreen] --
 * exactly the same widget in both places (per the new design), including the
 * photo-edit affordance, so a customer can change their photo from either
 * screen. Each caller owns its own photo-fetch/upload state independently
 * (this app has no shared view-model layer -- every screen manages its own
 * ApiClient calls, see e.g. the getPinStatus/getReferralInfo pattern above)
 * and just passes it in here for rendering.
 */
@Composable
internal fun ProfileAvatarCard(
    customer: CustomerProfile?,
    photoBitmap: androidx.compose.ui.graphics.ImageBitmap?,
    photoUploading: Boolean,
    photoError: String?,
    compact: Boolean,
    onPickPhoto: () -> Unit,
    nameModifier: Modifier = Modifier,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Surface(
            shape = RoundedCornerShape(20.dp),
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier.fillMaxWidth().shadow(2.dp, RoundedCornerShape(20.dp)),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = if (compact) 20.dp else 28.dp, horizontal = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box {
                    Box(
                        modifier = Modifier
                            .size(if (compact) 72.dp else 84.dp)
                            .clip(CircleShape)
                            .background(Color(0xFFDCEBFF)),
                        contentAlignment = Alignment.Center,
                    ) {
                        when {
                            photoBitmap != null -> Image(
                                bitmap = photoBitmap,
                                contentDescription = null,
                                modifier = Modifier.fillMaxSize().clip(CircleShape),
                                contentScale = ContentScale.Crop,
                            )
                            photoUploading -> CircularProgressIndicator(
                                modifier = Modifier.size(28.dp),
                                strokeWidth = 2.dp,
                                color = HeaderStart,
                            )
                            else -> Icon(
                                Icons.Filled.Person,
                                contentDescription = null,
                                tint = HeaderStart,
                                modifier = Modifier.size(40.dp),
                            )
                        }
                    }
                    // Green edit badge -- the only entry point for changing the
                    // photo. Tapping the name below (nameModifier, wired
                    // differently per screen) is a separate affordance, so the
                    // two distinct edits (photo vs. name) never collide.
                    Box(
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .size(28.dp)
                            .clip(CircleShape)
                            .background(DalabGreen)
                            .border(3.dp, MaterialTheme.colorScheme.surface, CircleShape)
                            .clickable(enabled = !photoUploading, onClick = onPickPhoto),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Filled.Edit,
                            contentDescription = LocalizationManager.tr("Change photo", "Beddel sawirka"),
                            tint = Color.White,
                            modifier = Modifier.size(12.dp),
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
                Text(
                    customer?.name?.takeIf { it.isNotBlank() } ?: "DALAB customer",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = nameModifier,
                )
                if (!customer?.phone.isNullOrBlank()) {
                    Text(
                        customer?.phone.orEmpty(),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (photoError != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        photoError,
                        color = MaterialTheme.colorScheme.error,
                        fontSize = 12.5.sp,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                }
            }
        }
    }
}

@Composable
private fun ProfileMenuRow(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    tint: Color = HeaderStart,
    showChevron: Boolean = true,
    showDivider: Boolean = true,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(tint.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.width(16.dp))
        Text(
            label,
            modifier = Modifier.weight(1f),
            fontSize = 15.sp,
            color = if (tint == HeaderStart) MaterialTheme.colorScheme.onSurface else tint,
        )
        if (showChevron) {
            Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = Color.Gray)
        }
    }
    if (showDivider) {
        Divider(modifier = Modifier.padding(start = 72.dp))
    }
}
