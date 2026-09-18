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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Image as ImageIcon
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
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.NalaSocoCreateRequest
import com.dalab.internet.network.NalaSocoPostResponse
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URL

/**
 * Full Nala Soco management -- create, edit, add/change images,
 * publish/unpublish, delete, view every post (including unpublished
 * drafts). The exact same capability the Admin dashboard's own Nala Soco
 * section has (App.jsx's DalabAdminApi.getNalaSocoPosts/create.../
 * update.../delete...), reachable identically from here since the backend
 * gates all four with requireAuth("super_admin","admin","agent") rather
 * than a staff-only check -- see ApiService.kt's own doc comment. The
 * Customer App only ever sees GET /nala-soco (published-only) -- neither
 * this app nor the Admin dashboard can bypass that, since publishing
 * happens through this exact same `published` field both write to.
 */
@Composable
fun NalaSocoManagementScreen(onBack: () -> Unit) {
    var posts by remember { mutableStateOf<List<NalaSocoPostResponse>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var formMode by remember { mutableStateOf<NalaSocoFormMode?>(null) }
    var deleteTarget by remember { mutableStateOf<NalaSocoPostResponse?>(null) }
    var busyId by remember { mutableStateOf<String?>(null) }

    val scope = rememberCoroutineScope()

    fun refresh() {
        loading = true
        loadError = null
        scope.launch {
            try {
                val response = ApiClient.service.getNalaSocoPosts()
                if (response.isSuccessful) posts = response.body().orEmpty()
                else loadError = "Could not load Nala Soco posts."
            } catch (_: Exception) {
                loadError = "Could not load Nala Soco posts. Check your connection."
            }
            loading = false
        }
    }
    LaunchedEffect(Unit) { refresh() }

    fun togglePublished(post: NalaSocoPostResponse) {
        busyId = post.id
        scope.launch {
            try {
                val body = JsonObject().apply { addProperty("published", !post.published) }
                val response = ApiClient.service.updateNalaSocoPost(post.id, body)
                if (response.isSuccessful) refresh()
            } catch (_: Exception) {
                // Silent -- the list simply keeps its last-known state; the agent
                // can retry the same tap.
            }
            busyId = null
        }
    }

    fun delete(post: NalaSocoPostResponse) {
        busyId = post.id
        scope.launch {
            try {
                ApiClient.service.deleteNalaSocoPost(post.id)
                refresh()
            } catch (_: Exception) {
                // Same silent-retry reasoning as togglePublished above.
            }
            busyId = null
            deleteTarget = null
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Nala Soco", fontWeight = FontWeight.Bold)
                        Text(
                            "Manage announcements shown in the Customer App",
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
            ExtendedFloatingActionButton(onClick = { formMode = NalaSocoFormMode.New }) {
                Icon(Icons.Filled.Add, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("New post")
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
                posts.isEmpty() -> Box(Modifier.fillMaxSize().padding(20.dp), contentAlignment = Alignment.Center) {
                    Text("No posts yet — tap \"New post\" to create one.", style = MaterialTheme.typography.bodyMedium, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
                else -> LazyColumn(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
                    item { Spacer(Modifier.height(8.dp)) }
                    items(posts, key = { it.id }) { post ->
                        NalaSocoPostCard(
                            post = post,
                            busy = busyId == post.id,
                            onTogglePublished = { togglePublished(post) },
                            onEdit = { formMode = NalaSocoFormMode.Edit(post) },
                            onDelete = { deleteTarget = post },
                        )
                        Spacer(Modifier.height(10.dp))
                    }
                    item { Spacer(Modifier.height(80.dp)) } // clears the FAB
                }
            }
        }
    }

    formMode?.let { mode ->
        NalaSocoFormDialog(
            mode = mode,
            onDismiss = { formMode = null },
            onSaved = { formMode = null; refresh() },
        )
    }

    deleteTarget?.let { post ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("Delete this post?") },
            text = { Text("\"${post.title}\" will be removed immediately and permanently. This can't be undone.") },
            confirmButton = {
                TextButton(onClick = { delete(post) }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text("Cancel") }
            },
        )
    }
}

private sealed class NalaSocoFormMode {
    object New : NalaSocoFormMode()
    data class Edit(val post: NalaSocoPostResponse) : NalaSocoFormMode()
}

@Composable
private fun NalaSocoPostCard(
    post: NalaSocoPostResponse,
    busy: Boolean,
    onTogglePublished: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(shape = RoundedCornerShape(14.dp), elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(post.title, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.height(4.dp))
                    Text(post.body, style = MaterialTheme.typography.bodySmall, maxLines = 3)
                }
                if (post.hasImage) {
                    Spacer(Modifier.width(10.dp))
                    Icon(ImageIcon, contentDescription = "Has image", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                }
            }
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                AssistChip(
                    onClick = {},
                    label = { Text(if (post.published) "Published" else "Draft") },
                    colors = AssistChipDefaults.assistChipColors(
                        containerColor = if (post.published) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                    ),
                )
                Spacer(Modifier.weight(1f))
                if (busy) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                } else {
                    IconButton(onClick = onTogglePublished) {
                        Icon(
                            if (post.published) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                            contentDescription = if (post.published) "Unpublish" else "Publish",
                        )
                    }
                    IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, contentDescription = "Edit") }
                    IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = "Delete", tint = MaterialTheme.colorScheme.error) }
                }
            }
        }
    }
}

/** New image the agent just picked, pending upload -- kept as its own type
 * (rather than reusing a plain nullable String) so "a new image is picked"
 * and "remove the post's current image" (see [NalaSocoFormDialog]'s own
 * `removeExistingImage` flag) can never be confused with each other. */
private data class PickedImage(val bytes: ByteArray, val mimeType: String) {
    val dataUri: String get() = "data:$mimeType;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
}

@Composable
private fun NalaSocoFormDialog(
    mode: NalaSocoFormMode,
    onDismiss: () -> Unit,
    onSaved: () -> Unit,
) {
    val existing = (mode as? NalaSocoFormMode.Edit)?.post
    var title by remember { mutableStateOf(existing?.title ?: "") }
    var body by remember { mutableStateOf(existing?.body ?: "") }
    var published by remember { mutableStateOf(existing?.published ?: true) }
    var pickedImage by remember { mutableStateOf<PickedImage?>(null) }
    // True once the agent explicitly asks to remove the post's existing
    // image -- distinct from "never touched the image at all" (both start
    // false/null, but only this one tells the save call to send
    // imageBase64: null instead of omitting the key entirely).
    var removeExistingImage by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val context = LocalContext.current
    val scope = rememberCoroutineScope()

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
                    val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
                    pickedImage = PickedImage(bytes, mime)
                    removeExistingImage = false
                }
            } catch (e: Exception) {
                error = "Couldn't read that image: ${e.message ?: "unknown error"}"
            }
        }
    }

    fun save() {
        if (title.isBlank() || body.isBlank()) {
            error = "Title and body are both required."
            return
        }
        saving = true
        error = null
        scope.launch {
            try {
                val response = if (existing == null) {
                    ApiClient.service.createNalaSocoPost(
                        NalaSocoCreateRequest(
                            title = title.trim(),
                            body = body.trim(),
                            published = published,
                            imageBase64 = pickedImage?.dataUri,
                        )
                    )
                } else {
                    val jsonBody = JsonObject().apply {
                        addProperty("title", title.trim())
                        addProperty("body", body.trim())
                        addProperty("published", published)
                        when {
                            pickedImage != null -> addProperty("imageBase64", pickedImage!!.dataUri)
                            removeExistingImage -> add("imageBase64", JsonNull.INSTANCE)
                            // Neither picked nor removed -- key omitted entirely,
                            // so the backend leaves the existing image untouched.
                        }
                    }
                    ApiClient.service.updateNalaSocoPost(existing.id, jsonBody)
                }
                if (response.isSuccessful) onSaved()
                else error = "Could not save this post."
            } catch (e: Exception) {
                error = "Could not save this post: ${e.message ?: "network error"}"
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
                    if (existing == null) "New Nala Soco Post" else "Edit Nala Soco Post",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(16.dp))

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
                    label = { Text("Body") },
                    minLines = 3,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(14.dp))

                Text("Image (optional)", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
                NalaSocoImagePicker(
                    existingPostId = existing?.id,
                    existingHasImage = existing?.hasImage == true && !removeExistingImage,
                    pickedImage = pickedImage,
                    onPick = { imagePickerLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    onRemove = { pickedImage = null; removeExistingImage = true },
                )
                Spacer(Modifier.height(14.dp))

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = published, onCheckedChange = { published = it })
                    Spacer(Modifier.width(10.dp))
                    Text("Published (visible in the Customer App)", style = MaterialTheme.typography.bodyMedium)
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
 * local bytes, no network), OR the post's already-uploaded image (fetched
 * once from the public, unauthenticated /nala-soco/:id/image route -- same
 * one the Customer App itself uses), OR an "Upload image" button when
 * neither applies. */
@Composable
private fun NalaSocoImagePicker(
    existingPostId: String?,
    existingHasImage: Boolean,
    pickedImage: PickedImage?,
    onPick: () -> Unit,
    onRemove: () -> Unit,
) {
    val pickedBitmap = remember(pickedImage) {
        pickedImage?.let { BitmapFactory.decodeByteArray(it.bytes, 0, it.bytes.size)?.asImageBitmap() }
    }
    var existingBitmap by remember(existingPostId, existingHasImage) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }

    LaunchedEffect(existingPostId, existingHasImage, pickedImage) {
        existingBitmap = null
        if (pickedImage != null || !existingHasImage || existingPostId == null) return@LaunchedEffect
        existingBitmap = withContext(Dispatchers.IO) {
            try {
                val bytes = URL("${ApiClient.BASE_URL}nala-soco/$existingPostId/image").openStream().use { it.readBytes() }
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
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onPick) { Text("Replace") }
                OutlinedButton(onClick = onRemove) { Text("Remove") }
            }
        }
    } else {
        OutlinedButton(onClick = onPick) {
            Icon(ImageIcon, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Upload image")
        }
    }
}
