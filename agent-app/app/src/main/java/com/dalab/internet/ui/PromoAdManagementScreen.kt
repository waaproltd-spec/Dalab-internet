package com.dalab.internet.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Image as ImageIcon
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.dalab.internet.data.Company
import com.dalab.internet.data.PackageItem
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.PromoAdCreateRequest
import com.dalab.internet.network.PromoAdResponse
import com.dalab.internet.network.PromoAdReorderRequest
import com.dalab.internet.network.PromoAdStatusRequest
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URL

/**
 * Full management of the Customer App's app-open promotional ad popup --
 * Add, Edit, Enable/Disable, Reorder, and Delete every slide. Structurally
 * a close twin of [NalaSocoManagementScreen] (same image-pick-and-base64
 * pattern, same create/edit dialog shape), but agent-only
 * (requireAuth("agent") on the backend, not shared with Admin) and against
 * its own separate promo_ads table -- entirely independent of both Nala
 * Soco and promo-images (the Home screen's own inline carousel banner),
 * which this screen never touches.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PromoAdManagementScreen(onBack: () -> Unit) {
    var ads by remember { mutableStateOf<List<PromoAdResponse>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var formMode by remember { mutableStateOf<PromoAdFormMode?>(null) }
    var deleteTarget by remember { mutableStateOf<PromoAdResponse?>(null) }
    var busyId by remember { mutableStateOf<String?>(null) }
    // Fetched once here (not inside the form dialog) so both the list's own
    // "-> <provider>" destination chip and the form's provider picker share
    // the same data without a duplicate network call every time the New/Edit
    // dialog opens.
    var companies by remember { mutableStateOf<List<Company>>(emptyList()) }

    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        try {
            val response = ApiClient.service.getCompanies()
            if (response.isSuccessful) companies = response.body().orEmpty()
        } catch (_: Exception) {
            // Silent -- the destination chip/picker just shows raw ids as a
            // fallback (see PromoAdCard/PromoAdFormDialog below) rather than
            // blocking the whole ad-management screen on this one fetch.
        }
    }

    fun refresh() {
        loading = true
        loadError = null
        scope.launch {
            try {
                val response = ApiClient.service.getPromoAds()
                if (response.isSuccessful) ads = response.body().orEmpty().sortedBy { it.position }
                else loadError = "Could not load promo ads."
            } catch (_: Exception) {
                loadError = "Could not load promo ads. Check your connection."
            }
            loading = false
        }
    }
    LaunchedEffect(Unit) { refresh() }

    fun toggleEnabled(ad: PromoAdResponse) {
        busyId = ad.id
        scope.launch {
            try {
                val response = ApiClient.service.updatePromoAdStatus(ad.id, PromoAdStatusRequest(!ad.enabled))
                if (response.isSuccessful) refresh()
            } catch (_: Exception) {
                // Silent -- the list simply keeps its last-known state; the agent
                // can retry the same tap.
            }
            busyId = null
        }
    }

    fun delete(ad: PromoAdResponse) {
        busyId = ad.id
        scope.launch {
            try {
                ApiClient.service.deletePromoAd(ad.id)
                refresh()
            } catch (_: Exception) {
                // Same silent-retry reasoning as toggleEnabled above.
            }
            busyId = null
            deleteTarget = null
        }
    }

    // Swaps this ad with its neighbor in the already-sorted `ads` list, then
    // sends the WHOLE new order (every ad's id) in one reorder call -- the
    // backend assigns position 0..n-1 from that exact sequence, so this is
    // always consistent even if positions had gaps/duplicates beforehand.
    fun move(ad: PromoAdResponse, delta: Int) {
        val index = ads.indexOfFirst { it.id == ad.id }
        val target = index + delta
        if (index < 0 || target < 0 || target >= ads.size) return
        val reordered = ads.toMutableList()
        val moved = reordered.removeAt(index)
        reordered.add(target, moved)
        ads = reordered // optimistic
        busyId = ad.id
        scope.launch {
            try {
                val response = ApiClient.service.reorderPromoAds(PromoAdReorderRequest(reordered.map { it.id }))
                if (response.isSuccessful) ads = response.body().orEmpty().sortedBy { it.position }
                else refresh()
            } catch (_: Exception) {
                refresh()
            }
            busyId = null
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Promo Ads", fontWeight = FontWeight.Bold)
                        Text(
                            "Manage the popup shown when the Customer App opens",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    Box(
                        modifier = Modifier.padding(end = 4.dp)
                            .size(40.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(MaterialTheme.colorScheme.primaryContainer),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Filled.Campaign,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(onClick = { formMode = PromoAdFormMode.New }) {
                Icon(Icons.Filled.Add, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("New ad")
            }
        },
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            when {
                loadError != null -> Column(
                    modifier = Modifier.fillMaxSize().padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(loadError!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = ::refresh) { Text("Retry") }
                }
                loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                ads.isEmpty() -> Box(Modifier.fillMaxSize().padding(20.dp), contentAlignment = Alignment.Center) {
                    Text("No promo ads yet — tap \"New ad\" to create one.", style = MaterialTheme.typography.bodyMedium, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
                else -> LazyColumn(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
                    item { Spacer(Modifier.height(8.dp)) }
                    items(ads, key = { it.id }) { ad ->
                        val index = ads.indexOfFirst { it.id == ad.id }
                        PromoAdCard(
                            ad = ad,
                            companies = companies,
                            busy = busyId == ad.id,
                            canMoveUp = index > 0,
                            canMoveDown = index >= 0 && index < ads.size - 1,
                            onToggleEnabled = { toggleEnabled(ad) },
                            onMoveUp = { move(ad, -1) },
                            onMoveDown = { move(ad, 1) },
                            onEdit = { formMode = PromoAdFormMode.Edit(ad) },
                            onDelete = { deleteTarget = ad },
                        )
                        Spacer(Modifier.height(10.dp))
                    }
                    item { Spacer(Modifier.height(80.dp)) } // clears the FAB
                }
            }
        }
    }

    formMode?.let { mode ->
        PromoAdFormDialog(
            mode = mode,
            companies = companies,
            onDismiss = { formMode = null },
            onSaved = { formMode = null; refresh() },
        )
    }

    deleteTarget?.let { ad ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("Delete this ad?") },
            text = { Text("${if (ad.title.isNullOrBlank()) "This ad" else "\"${ad.title}\""} will be removed immediately and permanently. This can't be undone.") },
            confirmButton = {
                TextButton(onClick = { delete(ad) }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text("Cancel") }
            },
        )
    }
}

private sealed class PromoAdFormMode {
    object New : PromoAdFormMode()
    data class Edit(val ad: PromoAdResponse) : PromoAdFormMode()
}

@Composable
private fun PromoAdCard(
    ad: PromoAdResponse,
    companies: List<Company>,
    busy: Boolean,
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    onToggleEnabled: () -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(shape = RoundedCornerShape(14.dp), elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(
                    verticalArrangement = Arrangement.Center,
                ) {
                    IconButton(onClick = onMoveUp, enabled = canMoveUp && !busy, modifier = Modifier.size(28.dp)) {
                        Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "Move up")
                    }
                    IconButton(onClick = onMoveDown, enabled = canMoveDown && !busy, modifier = Modifier.size(28.dp)) {
                        Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "Move down")
                    }
                }
                Spacer(Modifier.width(6.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        ad.title?.takeIf { it.isNotBlank() } ?: "(No title)",
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.titleSmall,
                    )
                    if (!ad.body.isNullOrBlank()) {
                        Spacer(Modifier.height(4.dp))
                        Text(ad.body, style = MaterialTheme.typography.bodySmall, maxLines = 3)
                    }
                }
                Spacer(Modifier.width(10.dp))
                Icon(Icons.Filled.ImageIcon, contentDescription = "Has image", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.height(10.dp))
            if (ad.destinationType != null) {
                Spacer(Modifier.height(6.dp))
                val companyName = companies.find { it.id == ad.destinationCompanyId }?.name ?: ad.destinationCompanyId ?: "?"
                Text(
                    if (ad.destinationType == "package") "→ $companyName (specific package)" else "→ $companyName packages",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.Bold,
                )
            }
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                AssistChip(
                    onClick = {},
                    label = { Text(if (ad.enabled) "Enabled" else "Disabled") },
                    colors = AssistChipDefaults.assistChipColors(
                        containerColor = if (ad.enabled) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                    ),
                )
                Spacer(Modifier.weight(1f))
                if (busy) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                } else {
                    IconButton(onClick = onToggleEnabled) {
                        Icon(
                            if (ad.enabled) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                            contentDescription = if (ad.enabled) "Disable" else "Enable",
                        )
                    }
                    IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, contentDescription = "Edit") }
                    IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = "Delete", tint = MaterialTheme.colorScheme.error) }
                }
            }
        }
    }
}

/** New image the agent just picked, pending upload -- see
 * NalaSocoManagementScreen's identical type for why this is kept separate
 * from a plain nullable String. */
private data class PickedAdImage(val bytes: ByteArray, val mimeType: String) {
    val dataUri: String get() = "data:$mimeType;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
}

// Every Promo Ad image must be exactly this size/aspect ratio -- matches
// the same fixed requirement promoAds.routes.ts enforces server-side.
private const val PROMO_AD_IMAGE_WIDTH = 1280
private const val PROMO_AD_IMAGE_HEIGHT = 720

private enum class PromoAdDestinationMode { NONE, COMPANY, PACKAGE }

// ExposedDropdownMenuBox/ExposedDropdownMenu (used by the destination
// picker below) are experimental Material3 APIs -- same opt-in
// PromoAdManagementScreen itself already carries, required here too since
// this is a separate composable function.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PromoAdFormDialog(
    mode: PromoAdFormMode,
    companies: List<Company>,
    onDismiss: () -> Unit,
    onSaved: () -> Unit,
) {
    val existing = (mode as? PromoAdFormMode.Edit)?.ad
    var title by remember { mutableStateOf(existing?.title ?: "") }
    var body by remember { mutableStateOf(existing?.body ?: "") }
    var pickedImage by remember { mutableStateOf<PickedAdImage?>(null) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // Tap destination -- see migration 110's header comment (admin-backend-ts)
    // for why type/companyId/packageId are always saved together as one
    // group. Pre-filled from the existing ad when editing.
    var destinationMode by remember {
        mutableStateOf(
            when (existing?.destinationType) {
                "company" -> PromoAdDestinationMode.COMPANY
                "package" -> PromoAdDestinationMode.PACKAGE
                else -> PromoAdDestinationMode.NONE
            }
        )
    }
    var selectedCompanyId by remember { mutableStateOf(existing?.destinationCompanyId) }
    var selectedPackageId by remember { mutableStateOf(existing?.destinationPackageId) }
    var packages by remember { mutableStateOf<List<PackageItem>>(emptyList()) }
    var packagesLoading by remember { mutableStateOf(false) }

    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // Only fetched when actually needed (specific-package mode with a
    // provider chosen) -- companies is already available for free from the
    // parent screen's own fetch, but packages are per-provider so there's no
    // single list to preload once for every possible destination.
    LaunchedEffect(destinationMode, selectedCompanyId) {
        if (destinationMode == PromoAdDestinationMode.PACKAGE && selectedCompanyId != null) {
            packagesLoading = true
            try {
                val response = ApiClient.service.getPackages(selectedCompanyId!!)
                packages = if (response.isSuccessful) response.body().orEmpty() else emptyList()
            } catch (_: Exception) {
                packages = emptyList()
            }
            packagesLoading = false
        } else {
            packages = emptyList()
        }
    }

    val imagePickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            try {
                val bytes = withContext(Dispatchers.IO) {
                    context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                }
                if (bytes != null) {
                    // Bounds-only decode (no pixel allocation) -- every
                    // Promo Ad image must be exactly 1280x720 (16:9), same
                    // requirement the backend enforces on upload; checking
                    // here lets the agent fix it immediately instead of
                    // discovering it from a failed Save.
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    if (bounds.outWidth != PROMO_AD_IMAGE_WIDTH || bounds.outHeight != PROMO_AD_IMAGE_HEIGHT) {
                        error = "Image must be exactly ${PROMO_AD_IMAGE_WIDTH}x$PROMO_AD_IMAGE_HEIGHT px (16:9)" +
                            " -- picked image is ${bounds.outWidth}x${bounds.outHeight}."
                        return@launch
                    }
                    val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
                    pickedImage = PickedAdImage(bytes, mime)
                    error = null
                }
            } catch (e: Exception) {
                error = "Couldn't read that image: ${e.message ?: "unknown error"}"
            }
        }
    }

    fun save() {
        if (existing == null && pickedImage == null) {
            error = "An image is required for a new ad."
            return
        }
        if (destinationMode != PromoAdDestinationMode.NONE && selectedCompanyId == null) {
            error = "Select a provider for the destination, or set it back to \"No destination\"."
            return
        }
        if (destinationMode == PromoAdDestinationMode.PACKAGE && selectedPackageId == null) {
            error = "Select a package for the destination, or switch to \"Provider's packages\"."
            return
        }
        val destType = when (destinationMode) {
            PromoAdDestinationMode.NONE -> null
            PromoAdDestinationMode.COMPANY -> "company"
            PromoAdDestinationMode.PACKAGE -> "package"
        }
        val destCompanyId = if (destinationMode != PromoAdDestinationMode.NONE) selectedCompanyId else null
        val destPackageId = if (destinationMode == PromoAdDestinationMode.PACKAGE) selectedPackageId else null

        saving = true
        error = null
        scope.launch {
            try {
                val response = if (existing == null) {
                    ApiClient.service.createPromoAd(
                        PromoAdCreateRequest(
                            imageBase64 = pickedImage!!.dataUri,
                            title = title.trim().ifBlank { null },
                            body = body.trim().ifBlank { null },
                            destinationType = destType,
                            destinationCompanyId = destCompanyId,
                            destinationPackageId = destPackageId,
                        )
                    )
                } else {
                    val jsonBody = JsonObject().apply {
                        addProperty("title", title.trim())
                        addProperty("body", body.trim())
                        if (pickedImage != null) addProperty("imageBase64", pickedImage!!.dataUri)
                        // Not picked -- key omitted entirely, so the backend
                        // leaves the existing image untouched (there is no
                        // "remove the image" option here, unlike Nala Soco --
                        // a promo ad's image is never optional).

                        // Always included (never omitted), including when
                        // destType is null (clearing a previously-set
                        // destination) -- the backend only touches these
                        // three columns when destinationType is present in
                        // the body at all, see promoAds.routes.ts's PUT
                        // handler doc comment.
                        if (destType != null) addProperty("destinationType", destType) else add("destinationType", JsonNull.INSTANCE)
                        if (destCompanyId != null) addProperty("destinationCompanyId", destCompanyId) else add("destinationCompanyId", JsonNull.INSTANCE)
                        if (destPackageId != null) addProperty("destinationPackageId", destPackageId) else add("destinationPackageId", JsonNull.INSTANCE)
                    }
                    ApiClient.service.updatePromoAd(existing.id, jsonBody)
                }
                if (response.isSuccessful) onSaved()
                else error = "Could not save this ad."
            } catch (e: Exception) {
                error = "Could not save this ad: ${e.message ?: "network error"}"
            }
            saving = false
        }
    }

    Dialog(onDismissRequest = { if (!saving) onDismiss() }) {
        Surface(shape = RoundedCornerShape(16.dp), color = Color.White) {
            Column(
                modifier = Modifier
                    .padding(20.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                Text(
                    if (existing == null) "New Promo Ad" else "Edit Promo Ad",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(16.dp))

                Text("Image" + if (existing == null) " (required)" else "", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(2.dp))
                Text(
                    "Must be exactly ${PROMO_AD_IMAGE_WIDTH}x$PROMO_AD_IMAGE_HEIGHT px (16:9)",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                PromoAdImagePicker(
                    existingAdId = existing?.id,
                    pickedImage = pickedImage,
                    onPick = { imagePickerLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                )
                Spacer(Modifier.height(14.dp))

                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("Title") },
                    singleLine = true,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(14.dp))

                OutlinedTextField(
                    value = body,
                    onValueChange = { body = it },
                    label = { Text("Promotional text") },
                    minLines = 3,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(16.dp))

                Text("Tap destination", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(2.dp))
                Text(
                    "Where tapping the ad (not the X or Sii wad button) sends the customer. Leave as \"No destination\" for the current behavior -- tapping just closes the popup.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                // Horizontally scrollable rather than a plain Row -- a
                // plain Row has no way to give each FilterChip its natural
                // width when the three together are wider than the dialog
                // (true for "Specific package" on most phone widths), so it
                // compresses them instead, wrapping "Specific package"'s
                // text one character per line. Scrolling keeps every chip's
                // label on one line; there are only three, so it reads
                // fine even without a visible scrollbar hint.
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                ) {
                    FilterChip(
                        selected = destinationMode == PromoAdDestinationMode.NONE,
                        onClick = {
                            destinationMode = PromoAdDestinationMode.NONE
                            selectedCompanyId = null
                            selectedPackageId = null
                        },
                        label = { Text("No destination") },
                    )
                    FilterChip(
                        selected = destinationMode == PromoAdDestinationMode.COMPANY,
                        onClick = {
                            destinationMode = PromoAdDestinationMode.COMPANY
                            selectedPackageId = null
                        },
                        label = { Text("Provider") },
                    )
                    FilterChip(
                        selected = destinationMode == PromoAdDestinationMode.PACKAGE,
                        onClick = { destinationMode = PromoAdDestinationMode.PACKAGE },
                        label = { Text("Specific package") },
                    )
                }

                if (destinationMode != PromoAdDestinationMode.NONE) {
                    Spacer(Modifier.height(10.dp))
                    var companyMenuExpanded by remember { mutableStateOf(false) }
                    val selectedCompanyName = companies.find { it.id == selectedCompanyId }?.name
                    ExposedDropdownMenuBox(expanded = companyMenuExpanded, onExpandedChange = { companyMenuExpanded = it }) {
                        OutlinedTextField(
                            value = selectedCompanyName ?: "Select provider",
                            onValueChange = {},
                            readOnly = true,
                            label = { Text("Provider") },
                            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = companyMenuExpanded) },
                            shape = RoundedCornerShape(14.dp),
                            modifier = Modifier.menuAnchor().fillMaxWidth(),
                        )
                        ExposedDropdownMenu(expanded = companyMenuExpanded, onDismissRequest = { companyMenuExpanded = false }) {
                            if (companies.isEmpty()) {
                                DropdownMenuItem(text = { Text("Loading providers...") }, onClick = {}, enabled = false)
                            }
                            companies.forEach { c ->
                                DropdownMenuItem(
                                    text = { Text(c.name) },
                                    onClick = {
                                        selectedCompanyId = c.id
                                        selectedPackageId = null
                                        companyMenuExpanded = false
                                    },
                                )
                            }
                        }
                    }
                }

                if (destinationMode == PromoAdDestinationMode.PACKAGE && selectedCompanyId != null) {
                    Spacer(Modifier.height(10.dp))
                    var packageMenuExpanded by remember { mutableStateOf(false) }
                    val selectedPackage = packages.find { it.id == selectedPackageId }
                    ExposedDropdownMenuBox(expanded = packageMenuExpanded, onExpandedChange = { packageMenuExpanded = it }) {
                        OutlinedTextField(
                            value = when {
                                selectedPackage != null -> "${selectedPackage.name} — $${selectedPackage.price}"
                                packagesLoading -> "Loading packages..."
                                selectedPackageId != null -> "Select package" // pre-filled id not in the loaded list yet
                                else -> "Select package"
                            },
                            onValueChange = {},
                            readOnly = true,
                            label = { Text("Package") },
                            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = packageMenuExpanded) },
                            shape = RoundedCornerShape(14.dp),
                            modifier = Modifier.menuAnchor().fillMaxWidth(),
                        )
                        ExposedDropdownMenu(expanded = packageMenuExpanded, onDismissRequest = { packageMenuExpanded = false }) {
                            if (!packagesLoading && packages.isEmpty()) {
                                DropdownMenuItem(text = { Text("No active packages for this provider") }, onClick = {}, enabled = false)
                            }
                            packages.forEach { p ->
                                DropdownMenuItem(
                                    text = { Text("${p.name} — $${p.price}") },
                                    onClick = {
                                        selectedPackageId = p.id
                                        packageMenuExpanded = false
                                    },
                                )
                            }
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))

                if (error != null) {
                    Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(8.dp))
                }

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss, enabled = !saving) { Text("Cancel") }
                    Spacer(Modifier.width(8.dp))
                    Button(onClick = ::save, enabled = !saving) { Text(if (saving) "Saving..." else "Save") }
                }
            }
        }
    }
}

/** Shows: a picked-but-not-yet-uploaded image (decoded straight from its
 * local bytes, no network), OR the ad's already-uploaded image (fetched
 * once from the public, unauthenticated /promo-ads/:id/image route -- same
 * one the Customer App itself uses), OR an "Upload image" button when
 * neither applies yet (new ad, nothing picked). */
@Composable
private fun PromoAdImagePicker(
    existingAdId: String?,
    pickedImage: PickedAdImage?,
    onPick: () -> Unit,
) {
    val pickedBitmap = remember(pickedImage) {
        pickedImage?.let { BitmapFactory.decodeByteArray(it.bytes, 0, it.bytes.size)?.asImageBitmap() }
    }
    var existingBitmap by remember(existingAdId) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }

    LaunchedEffect(existingAdId, pickedImage) {
        existingBitmap = null
        if (pickedImage != null || existingAdId == null) return@LaunchedEffect
        existingBitmap = withContext(Dispatchers.IO) {
            try {
                val bytes = URL("${ApiClient.BASE_URL}promo-ads/$existingAdId/image").openStream().use { it.readBytes() }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
            } catch (_: Exception) {
                null
            }
        }
    }

    val previewBitmap = pickedBitmap ?: existingBitmap
    if (previewBitmap != null) {
        Column {
            Image(
                bitmap = previewBitmap,
                contentDescription = null,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(140.dp)
                    .clip(RoundedCornerShape(10.dp)),
                contentScale = androidx.compose.ui.layout.ContentScale.Crop,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onPick) { Text("Replace") }
        }
    } else {
        OutlinedButton(onClick = onPick) {
            Icon(Icons.Filled.ImageIcon, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Upload image")
        }
    }
}
