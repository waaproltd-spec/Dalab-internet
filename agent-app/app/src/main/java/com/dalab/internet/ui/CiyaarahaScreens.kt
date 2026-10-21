@file:OptIn(ExperimentalMaterial3Api::class)

package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import com.dalab.internet.ui.i18n.tr
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material.icons.filled.Image as ImageIcon
import androidx.compose.material.icons.filled.PersonSearch
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SportsSoccer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.data.Company
import com.dalab.internet.data.FootballConfirmWinnerRequest
import com.dalab.internet.data.FootballContest
import com.dalab.internet.data.FootballContestCreateRequest
import com.dalab.internet.data.FootballCustomerSearchResponse
import com.dalab.internet.data.FootballGoalsRequest
import com.dalab.internet.data.FootballImageUploadRequest
import com.dalab.internet.data.FootballPostponeRequest
import com.dalab.internet.data.FootballPredictionsPage
import com.dalab.internet.data.FootballReasonRequest
import com.dalab.internet.data.FootballRewardRequest
import com.dalab.internet.data.FootballTeamInput
import com.dalab.internet.data.FootballTeamOption
import com.dalab.internet.network.ApiClient
import com.dalab.internet.util.parseApiDate
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import retrofit2.Response
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Ciyaaraha -- football exact-score prediction contests, for the agents an
 * Admin switched on (agents.ciyaaraha_enabled). Create and publish matches,
 * postpone or cancel them, enter the official score, search the
 * predictions for it ("Raadi Saadaasha Saxda ah", ordered by server time),
 * confirm the server's candidate as the winner, record the manually sent
 * internet reward, and look up a customer ("Raadi Macmiil").
 *
 * The backend (football.routes.ts) decides everything that matters: the
 * deadline, the candidate (the earliest exact prediction), who may be
 * confirmed, and that a reward can only be paid once. This screen never
 * picks a winner itself -- Confirm Winner only appears for the server's
 * candidate and sends that exact prediction id.
 */
private val SOMALIA_TZ: TimeZone = TimeZone.getTimeZone("Africa/Mogadishu")

private fun somaliaTime(raw: String?): String {
    val d = parseApiDate(raw) ?: return "—"
    return SimpleDateFormat("d MMM yyyy, HH:mm", Locale.US).apply { timeZone = SOMALIA_TZ }.format(d)
}

private fun isoUtc(date: Date): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(date)

/** Every football route returns `{error: "..."}` on failure. */
private fun <T> footballError(response: Response<T>, fallback: String): String {
    val raw = try { response.errorBody()?.string() } catch (_: Exception) { null }
    if (raw.isNullOrBlank()) return fallback
    return try {
        JsonParser.parseString(raw).asJsonObject.get("error")?.asString ?: fallback
    } catch (_: Exception) {
        fallback
    }
}

private fun statusLabel(status: String): String = when (status) {
    "draft" -> "Draft"
    "open" -> "Predictions Open"
    "closed" -> "Predictions Closed"
    "awaiting_result" -> "Awaiting Result"
    "verification" -> "Winner Verification"
    "completed" -> "Completed"
    "no_winner" -> "No Winner"
    "cancelled" -> "Cancelled"
    "disputed" -> "Disputed"
    else -> status
}

@Composable
private fun statusColor(status: String): Color = when (status) {
    "open" -> Color(0xFF16A34A)
    "closed", "awaiting_result", "disputed" -> Color(0xFFD97706)
    "verification" -> Color(0xFF2563EB)
    "cancelled" -> MaterialTheme.colorScheme.error
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

private fun winnerStatusLabel(status: String?): String = when (status) {
    "winner_confirmed" -> "Winner confirmed"
    "reward_pending" -> "Reward pending"
    "reward_paid" -> "Reward paid"
    "reward_failed" -> "Reward failed"
    "disputed" -> "Disputed"
    "revoked" -> "Revoked"
    else -> status ?: "—"
}

private fun outcomeLabel(outcome: String): String = when (outcome) {
    "won" -> "Winner"
    "correct_not_first" -> "Correct, not first"
    "lost" -> "Not correct"
    "cancelled" -> "Cancelled"
    else -> "Pending"
}

private sealed class CiyaarahaPage {
    object Contests : CiyaarahaPage()
    object Create : CiyaarahaPage()
    data class Detail(val id: String) : CiyaarahaPage()
    object CustomerSearch : CiyaarahaPage()
}

@Composable
fun CiyaarahaScreen(onBack: () -> Unit) {
    var page by remember { mutableStateOf<CiyaarahaPage>(CiyaarahaPage.Contests) }
    var enabled by remember { mutableStateOf<Boolean?>(null) }
    var accessError by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(reloadKey) {
        accessError = null
        try {
            val r = ApiClient.service.getFootballAccess()
            if (r.isSuccessful) enabled = r.body()?.enabled == true else accessError = footballError(r, "Could not check Ciyaaraha access.")
        } catch (_: Exception) {
            accessError = "Could not check Ciyaaraha access. Check your connection."
        }
    }

    BackHandler(enabled = page != CiyaarahaPage.Contests) { page = CiyaarahaPage.Contests }

    when {
        accessError != null -> CiyaarahaMessage(accessError!!, onBack = onBack, onRetry = { reloadKey++ })
        enabled == null -> CiyaarahaMessage(null, onBack = onBack)
        enabled == false -> CiyaarahaMessage("Ciyaaraha isn't enabled for this agent account. Ask an Admin to turn it on.", onBack = onBack)
        else -> when (val p = page) {
            CiyaarahaPage.Contests -> ContestListPage(
                onBack = onBack,
                onCreate = { page = CiyaarahaPage.Create },
                onOpen = { page = CiyaarahaPage.Detail(it) },
                onSearchCustomer = { page = CiyaarahaPage.CustomerSearch },
            )
            CiyaarahaPage.Create -> CreateContestPage(
                onBack = { page = CiyaarahaPage.Contests },
                onCreated = { page = CiyaarahaPage.Detail(it) },
            )
            is CiyaarahaPage.Detail -> ContestDetailPage(id = p.id, onBack = { page = CiyaarahaPage.Contests })
            CiyaarahaPage.CustomerSearch -> CustomerSearchPage(
                onBack = { page = CiyaarahaPage.Contests },
                onOpenContest = { page = CiyaarahaPage.Detail(it) },
            )
        }
    }
}

@Composable
private fun CiyaarahaTopBar(title: String, subtitle: String? = null, onBack: () -> Unit, actions: @Composable RowScope.() -> Unit = {}) {
    TopAppBar(
        title = {
            Column {
                Text(title, fontWeight = FontWeight.Bold)
                if (subtitle != null) {
                    Text(subtitle, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = tr("Back")) } },
        actions = actions,
    )
}

@Composable
private fun CiyaarahaMessage(message: String?, onBack: () -> Unit, onRetry: (() -> Unit)? = null) {
    Scaffold(topBar = { CiyaarahaTopBar("Ciyaaraha", onBack = onBack) }) { padding ->
        Column(
            modifier = Modifier.padding(padding).fillMaxSize().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            if (message == null) CircularProgressIndicator()
            else {
                Text(message, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyMedium)
                if (onRetry != null) {
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = onRetry) { Text("Retry") }
                }
            }
        }
    }
}

// ---------------- list ----------------

@Composable
private fun ContestListPage(onBack: () -> Unit, onCreate: () -> Unit, onOpen: (String) -> Unit, onSearchCustomer: () -> Unit) {
    var history by rememberSaveable { mutableStateOf(false) }
    var contests by remember { mutableStateOf<List<FootballContest>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(history, reloadKey) {
        loading = true
        error = null
        try {
            val r = ApiClient.service.getFootballContests(if (history) "history" else "active")
            if (r.isSuccessful) contests = r.body().orEmpty() else error = footballError(r, "Could not load contests.")
        } catch (_: Exception) {
            error = "Could not load contests. Check your connection."
        }
        loading = false
    }

    Scaffold(
        topBar = {
            CiyaarahaTopBar("Ciyaaraha", "Football score predictions", onBack) {
                IconButton(onClick = onSearchCustomer) { Icon(Icons.Filled.PersonSearch, contentDescription = tr("Search Customer")) }
                IconButton(onClick = { reloadKey++ }) { Icon(Icons.Filled.Refresh, contentDescription = tr("Refresh")) }
            }
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(onClick = onCreate) {
                Icon(Icons.Filled.Add, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("New Contest")
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = !history, onClick = { history = false }, label = { Text("Active") })
                FilterChip(selected = history, onClick = { history = true }, label = { Text("History") })
            }
            when {
                loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                error != null -> Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Text(error!!, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = { reloadKey++ }) { Text("Retry") }
                }
                contests.isEmpty() -> Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                    Text(if (history) "No finished contests yet." else "No active contests. Tap \"New Contest\" to create one.", textAlign = TextAlign.Center)
                }
                else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
                    items(contests, key = { it.id }) { c ->
                        ContestCard(c, onClick = { onOpen(c.id) })
                        Spacer(Modifier.height(10.dp))
                    }
                    item { Spacer(Modifier.height(80.dp)) }
                }
            }
        }
    }
}

@Composable
private fun StatusPill(status: String) {
    val color = statusColor(status)
    Box(
        Modifier.clip(RoundedCornerShape(20.dp)).background(color.copy(alpha = 0.14f)).padding(horizontal = 10.dp, vertical = 4.dp),
    ) { Text(statusLabel(status), color = color, fontSize = 12.sp, fontWeight = FontWeight.Bold) }
}

@Composable
private fun ContestCard(c: FootballContest, onClick: () -> Unit) {
    Card(shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(c.league, style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                StatusPill(c.status)
            }
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(c.homeTeam.name, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f), textAlign = TextAlign.Start)
                Text(
                    c.officialScore?.let { "${it.home} - ${it.away}" } ?: "VS",
                    fontWeight = FontWeight.Black,
                    fontSize = 18.sp,
                    modifier = Modifier.padding(horizontal = 10.dp),
                )
                Text(c.awayTeam.name, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f), textAlign = TextAlign.End)
            }
            Spacer(Modifier.height(8.dp))
            LabeledValue("Kickoff", somaliaTime(c.kickoffAt))
            LabeledValue("Reward", "${c.rewardLabel} · ${c.rewardCompany.name}")
            LabeledValue("Participants", "${c.participants}")
        }
    }
}

@Composable
private fun LabeledValue(label: String, value: String, valueColor: Color = Color.Unspecified) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(8.dp))
        Text(value, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, color = valueColor, modifier = Modifier.weight(1f), textAlign = TextAlign.End)
    }
}

// ---------------- create ----------------

private class PickedFootballImage(val bytes: ByteArray, val mimeType: String) {
    val dataUri: String get() = "data:$mimeType;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    val bitmap: ImageBitmap? by lazy { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
}

private const val MAX_IMAGE_BYTES = 2 * 1024 * 1024

@Composable
private fun rememberImagePicker(onPicked: (PickedFootballImage) -> Unit, onError: (String) -> Unit): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            try {
                val bytes = withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }
                val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
                when {
                    bytes == null -> onError(tr("Couldn't read that image."))
                    bytes.size > MAX_IMAGE_BYTES -> onError(tr("Image is too large (max 2 MB)."))
                    mime !in listOf("image/png", "image/jpeg", "image/webp") -> onError(tr("Use a PNG, JPEG or WebP image."))
                    else -> onPicked(PickedFootballImage(bytes, mime))
                }
            } catch (_: Exception) {
                onError(tr("Couldn't read that image."))
            }
        }
    }
    return { launcher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
}

private val DEADLINE_OPTIONS = listOf(0 to "At kickoff", 15 to "15 minutes before", 30 to "30 minutes before", 60 to "1 hour before")

@Composable
private fun CreateContestPage(onBack: () -> Unit, onCreated: (String) -> Unit) {
    var homeName by remember { mutableStateOf("") }
    var awayName by remember { mutableStateOf("") }
    var homeLogo by remember { mutableStateOf<PickedFootballImage?>(null) }
    var awayLogo by remember { mutableStateOf<PickedFootballImage?>(null) }
    var contestImage by remember { mutableStateOf<PickedFootballImage?>(null) }
    var league by remember { mutableStateOf("") }
    var kickoff by remember { mutableStateOf<Date?>(null) }
    var deadlineMinutes by remember { mutableStateOf(0) }
    var rewardLabel by remember { mutableStateOf("") }
    var companyId by remember { mutableStateOf<String?>(null) }
    var publish by remember { mutableStateOf(true) }
    var companies by remember { mutableStateOf<List<Company>>(emptyList()) }
    var teams by remember { mutableStateOf<List<FootballTeamOption>>(emptyList()) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showKickoffPicker by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        try { ApiClient.service.getCompanies().body()?.let { companies = it } } catch (_: Exception) {}
        try { ApiClient.service.getFootballTeams().body()?.let { teams = it } } catch (_: Exception) {}
    }

    val pickHomeLogo = rememberImagePicker({ homeLogo = it }, { error = it })
    val pickAwayLogo = rememberImagePicker({ awayLogo = it }, { error = it })
    val pickContestImage = rememberImagePicker({ contestImage = it }, { error = it })

    fun save() {
        val k = kickoff
        when {
            homeName.trim().length < 2 || awayName.trim().length < 2 -> { error = tr("Enter both team names."); return }
            homeName.trim().equals(awayName.trim(), ignoreCase = true) -> { error = tr("The two teams must be different."); return }
            league.isBlank() -> { error = tr("Enter the league or competition."); return }
            k == null -> { error = tr("Choose the kickoff date and time."); return }
            k.time <= System.currentTimeMillis() + 5 * 60_000 -> { error = tr("Kickoff must be in the future."); return }
            rewardLabel.isBlank() -> { error = tr("Enter the reward, e.g. 1 GB Internet."); return }
            companyId == null -> { error = tr("Choose the reward provider."); return }
        }
        saving = true
        error = null
        scope.launch {
            try {
                suspend fun upload(img: PickedFootballImage?, purpose: String): String? {
                    if (img == null) return null
                    val r = ApiClient.service.uploadFootballImage(FootballImageUploadRequest(img.dataUri, purpose))
                    if (!r.isSuccessful) throw IllegalStateException(footballError(r, tr("Image upload failed.")))
                    return r.body()?.id
                }
                val homeLogoId = upload(homeLogo, "team_logo")
                val awayLogoId = upload(awayLogo, "team_logo")
                val imageId = upload(contestImage, "contest_image")
                val close = Date(k!!.time - deadlineMinutes * 60_000L)
                val r = ApiClient.service.createFootballContest(
                    FootballContestCreateRequest(
                        homeTeam = FootballTeamInput(homeName.trim(), homeLogoId),
                        awayTeam = FootballTeamInput(awayName.trim(), awayLogoId),
                        league = league.trim(),
                        kickoffAt = isoUtc(k),
                        predictionsCloseAt = isoUtc(close),
                        rewardLabel = rewardLabel.trim(),
                        rewardCompanyId = companyId!!,
                        imageId = imageId,
                        publish = publish,
                    )
                )
                val created = r.body()
                if (r.isSuccessful && created != null) onCreated(created.id) else error = footballError(r, tr("Could not create the contest."))
            } catch (e: IllegalStateException) {
                error = e.message
            } catch (_: Exception) {
                error = tr("Could not create the contest. Check your connection.")
            }
            saving = false
        }
    }

    Scaffold(topBar = { CiyaarahaTopBar("New Contest", onBack = onBack) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
            TeamField("Home team", homeName, { homeName = it }, teams, homeLogo, pickHomeLogo, onRemoveLogo = { homeLogo = null })
            Spacer(Modifier.height(12.dp))
            TeamField("Away team", awayName, { awayName = it }, teams, awayLogo, pickAwayLogo, onRemoveLogo = { awayLogo = null })
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(league, { league = it }, label = { Text("League / competition") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))
            OutlinedButton(onClick = { showKickoffPicker = true }, modifier = Modifier.fillMaxWidth()) {
                Text(kickoff?.let { tr("Kickoff") + ": " + SimpleDateFormat("d MMM yyyy, HH:mm", Locale.US).apply { timeZone = SOMALIA_TZ }.format(it) } ?: tr("Choose kickoff (Somalia time)"))
            }
            Spacer(Modifier.height(12.dp))
            Text("Predictions close", style = MaterialTheme.typography.labelLarge)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                DEADLINE_OPTIONS.forEach { (minutes, label) ->
                    FilterChip(selected = deadlineMinutes == minutes, onClick = { deadlineMinutes = minutes }, label = { Text(label) })
                }
            }
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(rewardLabel, { rewardLabel = it }, label = { Text("Reward (e.g. 1 GB Internet)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))
            Text("Reward provider", style = MaterialTheme.typography.labelLarge)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                companies.forEach { co -> FilterChip(selected = companyId == co.id, onClick = { companyId = co.id }, label = { Text(co.name) }) }
            }
            Spacer(Modifier.height(12.dp))
            Text("Match image (optional)", style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.height(6.dp))
            ImagePickRow(contestImage, pickContestImage, onRemove = { contestImage = null }, height = 140)
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = publish, onCheckedChange = { publish = it })
                Spacer(Modifier.width(10.dp))
                Text(if (publish) "Publish now (customers can predict)" else "Save as draft", style = MaterialTheme.typography.bodyMedium)
            }
            if (error != null) {
                Spacer(Modifier.height(10.dp))
                Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(16.dp))
            Button(onClick = ::save, enabled = !saving, modifier = Modifier.fillMaxWidth().height(50.dp)) {
                Text(if (saving) "Saving..." else "Create Contest")
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    if (showKickoffPicker) {
        DateTimePickerDialog(
            initial = kickoff,
            onDismiss = { showKickoffPicker = false },
            onPicked = { kickoff = it; showKickoffPicker = false },
        )
    }
}

@Composable
private fun TeamField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    teams: List<FootballTeamOption>,
    logo: PickedFootballImage?,
    onPickLogo: () -> Unit,
    onRemoveLogo: () -> Unit,
) {
    val suggestions = remember(value, teams) {
        if (value.isBlank()) emptyList()
        else teams.filter { it.name.contains(value.trim(), ignoreCase = true) && !it.name.equals(value.trim(), ignoreCase = true) }.take(4)
    }
    Column {
        OutlinedTextField(value, onChange, label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        if (suggestions.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                suggestions.forEach { t -> AssistChip(onClick = { onChange(t.name) }, label = { Text(t.name) }) }
            }
        }
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            val bmp = logo?.bitmap
            if (bmp != null) {
                Image(bmp, contentDescription = null, modifier = Modifier.size(40.dp).clip(CircleShape), contentScale = ContentScale.Crop)
                Spacer(Modifier.width(8.dp))
                TextButton(onClick = onPickLogo) { Text("Change logo") }
                TextButton(onClick = onRemoveLogo) { Text("Remove") }
            } else {
                TextButton(onClick = onPickLogo) {
                    Icon(Icons.Filled.ImageIcon, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Add logo (optional)")
                }
            }
        }
    }
}

@Composable
private fun ImagePickRow(image: PickedFootballImage?, onPick: () -> Unit, onRemove: () -> Unit, height: Int) {
    val bmp = image?.bitmap
    if (bmp != null) {
        Column {
            Image(bmp, contentDescription = null, modifier = Modifier.fillMaxWidth().height(height.dp).clip(RoundedCornerShape(10.dp)), contentScale = ContentScale.Crop)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onPick) { Text("Replace") }
                OutlinedButton(onClick = onRemove) { Text("Remove") }
            }
        }
    } else {
        OutlinedButton(onClick = onPick) {
            Icon(Icons.Filled.ImageIcon, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Upload image")
        }
    }
}

/** Date then time, both read as Somalia (Africa/Mogadishu) wall-clock time. */
@Composable
private fun DateTimePickerDialog(initial: Date?, onDismiss: () -> Unit, onPicked: (Date) -> Unit) {
    var pickedDayUtcMillis by remember { mutableStateOf<Long?>(null) }
    val initialCal = Calendar.getInstance(SOMALIA_TZ).apply { time = initial ?: Date(System.currentTimeMillis() + 3_600_000) }
    if (pickedDayUtcMillis == null) {
        val dateState = rememberDatePickerState(initialSelectedDateMillis = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
            clear()
            set(initialCal.get(Calendar.YEAR), initialCal.get(Calendar.MONTH), initialCal.get(Calendar.DAY_OF_MONTH))
        }.timeInMillis)
        DatePickerDialog(
            onDismissRequest = onDismiss,
            confirmButton = { TextButton(onClick = { pickedDayUtcMillis = dateState.selectedDateMillis }, enabled = dateState.selectedDateMillis != null) { Text("Next") } },
            dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        ) { DatePicker(state = dateState) }
    } else {
        val timeState = rememberTimePickerState(initialHour = initialCal.get(Calendar.HOUR_OF_DAY), initialMinute = initialCal.get(Calendar.MINUTE), is24Hour = true)
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("Kickoff time (Somalia)") },
            text = { TimePicker(state = timeState) },
            confirmButton = {
                TextButton(onClick = {
                    val day = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = pickedDayUtcMillis!! }
                    val result = Calendar.getInstance(SOMALIA_TZ).apply {
                        clear()
                        set(day.get(Calendar.YEAR), day.get(Calendar.MONTH), day.get(Calendar.DAY_OF_MONTH), timeState.hour, timeState.minute, 0)
                    }
                    onPicked(result.time)
                }) { Text("Done") }
            },
            dismissButton = { TextButton(onClick = { pickedDayUtcMillis = null }) { Text("Back") } },
        )
    }
}

// ---------------- detail ----------------

@Composable
private fun ContestDetailPage(id: String, onBack: () -> Unit) {
    var contest by remember { mutableStateOf<FootballContest?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var actionInfo by remember { mutableStateOf<String?>(null) }
    var dialog by remember { mutableStateOf<String?>(null) } // result, postpone, cancel, dispute, paid, failed, confirm
    val scope = rememberCoroutineScope()

    LaunchedEffect(id, reloadKey) {
        loadError = null
        try {
            val r = ApiClient.service.getFootballContest(id)
            if (r.isSuccessful) contest = r.body() else loadError = footballError(r, "Could not load this contest.")
        } catch (_: Exception) {
            loadError = "Could not load this contest. Check your connection."
        }
    }

    fun act(success: String, call: suspend () -> Response<*>) {
        busy = true
        actionError = null
        actionInfo = null
        scope.launch {
            try {
                val r = call()
                if (r.isSuccessful) { actionInfo = tr(success); dialog = null; reloadKey++ } else actionError = footballError(r, tr("That didn't work. Try again."))
            } catch (_: Exception) {
                actionError = tr("That didn't work. Check your connection.")
            }
            busy = false
        }
    }

    Scaffold(topBar = {
        CiyaarahaTopBar("Contest", contest?.let { "${it.homeTeam.name} vs ${it.awayTeam.name}" }, onBack) {
            IconButton(onClick = { reloadKey++ }) { Icon(Icons.Filled.Refresh, contentDescription = tr("Refresh")) }
        }
    }) { padding ->
        val c = contest
        when {
            loadError != null && c == null -> Column(Modifier.padding(padding).fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text(loadError!!, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
                Spacer(Modifier.height(12.dp))
                Button(onClick = { reloadKey++ }) { Text("Retry") }
            }
            c == null -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            else -> {
                val kickoffPassed = (parseApiDate(c.kickoffAt)?.time ?: Long.MAX_VALUE) <= System.currentTimeMillis()
                val canEnterResult = kickoffPassed && c.status in listOf("open", "closed", "awaiting_result", "verification", "no_winner")
                Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                    ContestHeaderCard(c)
                    if (actionInfo != null) { Spacer(Modifier.height(8.dp)); Text(actionInfo!!, color = Color(0xFF16A34A), fontWeight = FontWeight.SemiBold) }
                    if (actionError != null) { Spacer(Modifier.height(8.dp)); Text(actionError!!, color = MaterialTheme.colorScheme.error) }
                    if (!c.statusReason.isNullOrBlank()) { Spacer(Modifier.height(8.dp)); LabeledValue("Reason", c.statusReason) }

                    Spacer(Modifier.height(12.dp))
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (c.status == "draft") Button(onClick = { act("Published.") { ApiClient.service.publishFootballContest(c.id) } }, enabled = !busy) { Text("Publish") }
                        if (canEnterResult) Button(onClick = { dialog = "result" }, enabled = !busy) { Text(if (c.officialScore == null) "Enter Result" else "Correct Result") }
                        if (c.status in listOf("draft", "open", "closed", "awaiting_result") && c.officialScore == null) OutlinedButton(onClick = { dialog = "postpone" }, enabled = !busy) { Text("Postpone") }
                        if (c.winner == null && c.status !in listOf("completed", "cancelled")) OutlinedButton(onClick = { dialog = "cancel" }, enabled = !busy) { Text("Cancel Match") }
                        if (c.status !in listOf("draft", "cancelled", "disputed")) OutlinedButton(onClick = { dialog = "dispute" }, enabled = !busy) { Text("Report Problem") }
                    }

                    if (c.officialScore != null) {
                        Spacer(Modifier.height(16.dp))
                        ResultSection(c, busy, onConfirm = { dialog = "confirm" })
                    }
                    if (c.winner != null) {
                        Spacer(Modifier.height(16.dp))
                        WinnerSection(c, busy,
                            onPending = { act("Marked as pending.") { ApiClient.service.recordFootballReward(c.id, FootballRewardRequest("pending")) } },
                            onPaid = { dialog = "paid" },
                            onFailed = { dialog = "failed" },
                        )
                    }
                    Spacer(Modifier.height(16.dp))
                    PredictionSearchSection(c)
                    if (!c.events.isNullOrEmpty()) {
                        Spacer(Modifier.height(16.dp))
                        SectionTitle("History")
                        c.events.forEach { e ->
                            LabeledValue(eventLabel(e.action), "${somaliaTime(e.createdAt)} · ${tr(e.actorType.replaceFirstChar { it.uppercase() })}")
                        }
                    }
                    Spacer(Modifier.height(32.dp))
                }

                when (dialog) {
                    "result" -> ScoreDialog(
                        title = if (c.officialScore == null) "Official result" else "Correct the result",
                        message = "${c.homeTeam.name} vs ${c.awayTeam.name}",
                        initial = c.officialScore?.let { it.home to it.away } ?: (0 to 0),
                        busy = busy,
                        onDismiss = { dialog = null },
                        onSave = { h, a -> act("Result saved.") { ApiClient.service.enterFootballResult(c.id, FootballGoalsRequest(h, a)) } },
                    )
                    "confirm" -> c.candidate?.let { cand ->
                        AlertDialog(
                            onDismissRequest = { dialog = null },
                            title = { Text("Confirm this winner?") },
                            text = {
                                Column {
                                    Text("${cand.customerName} (${cand.phoneMasked})", fontWeight = FontWeight.Bold)
                                    Text(tr("Prediction") + ": ${cand.home} - ${cand.away}")
                                    Text(tr("Submitted") + ": ${somaliaTime(cand.submittedAt)}")
                                    Spacer(Modifier.height(8.dp))
                                    Text("The customer will be notified that they won. This can't be undone from the app.")
                                }
                            },
                            confirmButton = { TextButton(onClick = { act("Winner confirmed. The customer has been notified.") { ApiClient.service.confirmFootballWinner(c.id, FootballConfirmWinnerRequest(cand.predictionId)) } }, enabled = !busy) { Text("Confirm Winner") } },
                            dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } },
                        )
                    }
                    "postpone" -> PostponeDialog(c, busy, onDismiss = { dialog = null }) { kickoff, closeAt, reason ->
                        act("Match postponed.") { ApiClient.service.postponeFootballContest(c.id, FootballPostponeRequest(isoUtc(kickoff), isoUtc(closeAt), reason)) }
                    }
                    "cancel" -> ReasonDialog("Cancel this match?", "Customers will see it as cancelled, with no winner.", "Cancel Match", busy, onDismiss = { dialog = null }) { reason ->
                        act("Match cancelled.") { ApiClient.service.cancelFootballContest(c.id, FootballReasonRequest(reason)) }
                    }
                    "dispute" -> ReasonDialog("Report a problem", "This pauses the contest and its reward until an Admin resolves it.", "Report", busy, onDismiss = { dialog = null }) { reason ->
                        act("Reported. An Admin will review it.") { ApiClient.service.disputeFootballContest(c.id, FootballReasonRequest(reason)) }
                    }
                    "paid" -> RewardDialog(paid = true, c, busy, onDismiss = { dialog = null }) { ref, note ->
                        act("Reward recorded as paid.") { ApiClient.service.recordFootballReward(c.id, FootballRewardRequest("paid", ref, note)) }
                    }
                    "failed" -> RewardDialog(paid = false, c, busy, onDismiss = { dialog = null }) { _, note ->
                        act("Recorded as failed. You can try again.") { ApiClient.service.recordFootballReward(c.id, FootballRewardRequest("failed", null, note)) }
                    }
                }
            }
        }
    }
}

private fun eventLabel(action: String): String = when (action) {
    "created" -> "Created"
    "published" -> "Published"
    "postponed" -> "Postponed"
    "cancelled" -> "Cancelled"
    "predictions_closed" -> "Predictions closed"
    "awaiting_result" -> "Awaiting result"
    "result_entered" -> "Result entered"
    "result_corrected" -> "Result corrected"
    "winner_confirmed" -> "Winner confirmed"
    "winner_notified" -> "Winner notified"
    "reward_pending" -> "Reward pending"
    "reward_paid" -> "Reward paid"
    "reward_failed" -> "Reward failed"
    "dispute_opened" -> "Problem reported"
    "dispute_resolved" -> "Dispute resolved"
    else -> action.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

@Composable
private fun SectionTitle(title: String) {
    Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
    Spacer(Modifier.height(6.dp))
}

@Composable
private fun ContestHeaderCard(c: FootballContest) {
    var image by remember(c.imageUrl) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(c.imageUrl) {
        val path = c.imageUrl ?: return@LaunchedEffect
        image = withContext(Dispatchers.IO) {
            try {
                val bytes = URL(ApiClient.BASE_URL.trimEnd('/') + path).openStream().use { it.readBytes() }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
            } catch (_: Exception) { null }
        }
    }
    Card(shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
        Column {
            image?.let { Image(it, contentDescription = null, modifier = Modifier.fillMaxWidth().height(140.dp), contentScale = ContentScale.Crop) }
            Column(Modifier.padding(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(c.league, style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                    StatusPill(c.status)
                }
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(c.homeTeam.name, fontWeight = FontWeight.Bold, fontSize = 16.sp, modifier = Modifier.weight(1f))
                    Text(c.officialScore?.let { "${it.home} - ${it.away}" } ?: "VS", fontWeight = FontWeight.Black, fontSize = 22.sp, modifier = Modifier.padding(horizontal = 10.dp))
                    Text(c.awayTeam.name, fontWeight = FontWeight.Bold, fontSize = 16.sp, modifier = Modifier.weight(1f), textAlign = TextAlign.End)
                }
                Spacer(Modifier.height(10.dp))
                LabeledValue("Kickoff", somaliaTime(c.kickoffAt))
                LabeledValue("Predictions close", somaliaTime(c.predictionsCloseAt))
                LabeledValue("Reward", "${c.rewardLabel} · ${c.rewardCompany.name}", Color(0xFF16A34A))
                LabeledValue("Participants", "${c.participants}")
            }
        }
    }
}

@Composable
private fun ResultSection(c: FootballContest, busy: Boolean, onConfirm: () -> Unit) {
    SectionTitle("Result & Winner Verification")
    Card(shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            LabeledValue("Official result", "${c.officialScore!!.home} - ${c.officialScore.away}")
            LabeledValue("Exact-score predictions", "${c.exactScoreCount ?: 0}")
            Spacer(Modifier.height(8.dp))
            val cand = c.candidate
            when {
                c.winner != null -> Text("Winner confirmed — see below.", style = MaterialTheme.typography.bodySmall)
                cand == null -> Text("No customer predicted this exact score. The contest has no winner.", style = MaterialTheme.typography.bodyMedium)
                else -> {
                    Text("Earliest correct prediction (server time)", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(4.dp))
                    LabeledValue("Customer", cand.customerName.ifBlank { "—" })
                    LabeledValue("Phone", cand.phoneMasked)
                    LabeledValue("Prediction", "${cand.home} - ${cand.away}")
                    LabeledValue("Submitted", somaliaTime(cand.submittedAt))
                    if (c.status == "verification") {
                        Spacer(Modifier.height(10.dp))
                        Button(onClick = onConfirm, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                            Icon(Icons.Filled.EmojiEvents, contentDescription = null)
                            Spacer(Modifier.width(8.dp))
                            Text("Confirm Winner")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun WinnerSection(c: FootballContest, busy: Boolean, onPending: () -> Unit, onPaid: () -> Unit, onFailed: () -> Unit) {
    val w = c.winner!!
    SectionTitle("Winner & Reward")
    Card(shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            LabeledValue("Winner", w.customerName.ifBlank { "—" })
            LabeledValue("Phone (send the reward here)", w.phone)
            LabeledValue("Prediction", "${w.home} - ${w.away}")
            LabeledValue("Submitted", somaliaTime(w.predictedAt))
            LabeledValue("Reward", "${c.rewardLabel} · ${c.rewardCompany.name}")
            LabeledValue("Status", tr(winnerStatusLabel(w.status)), if (w.status == "reward_paid") Color(0xFF16A34A) else Color.Unspecified)
            LabeledValue("Notified", if (w.notifiedAt != null) somaliaTime(w.notifiedAt) else tr("Not yet"))
            if (w.status in listOf("winner_confirmed", "reward_pending", "reward_failed")) {
                Spacer(Modifier.height(10.dp))
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (w.status == "winner_confirmed") OutlinedButton(onClick = onPending, enabled = !busy) { Text("Mark Pending") }
                    Button(onClick = onPaid, enabled = !busy) { Text("Record Paid") }
                    OutlinedButton(onClick = onFailed, enabled = !busy) { Text("Record Failed") }
                }
            }
            val rewards = c.rewards.orEmpty()
            if (rewards.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Text("Reward attempts", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                rewards.forEach { r ->
                    LabeledValue(
                        "#${r.attemptNo} · ${tr(if (r.status == "paid") "Paid" else "Failed")}",
                        listOfNotNull(r.transactionRef, r.note, somaliaTime(r.createdAt)).joinToString(" · "),
                    )
                }
            }
        }
    }
}

/** Raadi Saadaasha Saxda ah: all predictions, or just one score, by server time. */
@Composable
private fun PredictionSearchSection(c: FootballContest) {
    var home by remember(c.id, c.officialScore) { mutableStateOf(c.officialScore?.home?.toString() ?: "") }
    var away by remember(c.id, c.officialScore) { mutableStateOf(c.officialScore?.away?.toString() ?: "") }
    var page by remember { mutableStateOf<FootballPredictionsPage?>(null) }
    var pageNo by remember { mutableStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var query by remember(c.id, c.officialScore) { mutableStateOf(c.officialScore?.let { it.home to it.away }) }
    val scope = rememberCoroutineScope()

    fun load(q: Pair<Int, Int>?, p: Int) {
        loading = true
        error = null
        scope.launch {
            try {
                val r = ApiClient.service.getFootballPredictions(c.id, q?.first, q?.second, p, 20)
                if (r.isSuccessful) { page = r.body(); pageNo = p } else error = footballError(r, tr("Search failed."))
            } catch (_: Exception) {
                error = tr("Search failed. Check your connection.")
            }
            loading = false
        }
    }
    LaunchedEffect(c.id, c.officialScore, c.winner?.id) { load(query, 0) }

    SectionTitle("Search Correct Predictions")
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(home, { home = it.filter(Char::isDigit).take(2) }, label = { Text(c.homeTeam.name, maxLines = 1) }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
        Text("-", fontWeight = FontWeight.Bold)
        OutlinedTextField(away, { away = it.filter(Char::isDigit).take(2) }, label = { Text(c.awayTeam.name, maxLines = 1) }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
    }
    Spacer(Modifier.height(6.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = {
            val h = home.toIntOrNull()
            val a = away.toIntOrNull()
            if (h == null || a == null) {
                error = tr("Enter both scores, e.g. 2 and 1.")
            } else {
                query = h to a
                load(query, 0)
            }
        }, enabled = !loading) { Text("Search") }
        OutlinedButton(onClick = { query = null; load(null, 0) }, enabled = !loading) { Text("Show All") }
    }
    if (error != null) Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    Spacer(Modifier.height(8.dp))
    val pg = page
    when {
        loading && pg == null -> CircularProgressIndicator(Modifier.size(24.dp))
        pg != null -> {
            Text(
                if (query == null) tr("All predictions") + ": ${pg.total}" else tr("Predictions for") + " ${query!!.first} - ${query!!.second}: ${pg.total}",
                style = MaterialTheme.typography.labelLarge,
            )
            if (pg.items.isEmpty()) Text(if (query == null) "No predictions yet." else "No customer predicted this score.", style = MaterialTheme.typography.bodySmall)
            pg.items.forEach { row ->
                Card(shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                    Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("#${row.position}", fontWeight = FontWeight.Black, modifier = Modifier.width(40.dp))
                        Column(Modifier.weight(1f)) {
                            Text("${row.customerName.ifBlank { "—" }} · ${row.phoneMasked}", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(somaliaTime(row.submittedAt), style = MaterialTheme.typography.bodySmall)
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text("${row.home} - ${row.away}", fontWeight = FontWeight.Bold)
                            when {
                                row.isWinner -> Text("Winner", color = Color(0xFF16A34A), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                row.isCandidate -> Text("Candidate", color = Color(0xFF2563EB), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                row.matchesOfficial == true -> Text("Correct, not first", fontSize = 11.sp)
                            }
                        }
                    }
                }
            }
            if (pg.total > pg.pageSize) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { load(query, pageNo - 1) }, enabled = pageNo > 0 && !loading) { Text("Previous") }
                    Text("${pageNo + 1} / ${(pg.total + pg.pageSize - 1) / pg.pageSize}")
                    TextButton(onClick = { load(query, pageNo + 1) }, enabled = (pageNo + 1) * pg.pageSize < pg.total && !loading) { Text("Next") }
                }
            }
        }
    }
}

@Composable
private fun ScoreDialog(title: String, message: String, initial: Pair<Int, Int>, busy: Boolean, onDismiss: () -> Unit, onSave: (Int, Int) -> Unit) {
    var home by remember { mutableStateOf(initial.first) }
    var away by remember { mutableStateOf(initial.second) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(title) },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text(message, textAlign = TextAlign.Center)
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    GoalStepper(home) { home = it }
                    Text("-", fontWeight = FontWeight.Black, fontSize = 22.sp, modifier = Modifier.padding(horizontal = 12.dp))
                    GoalStepper(away) { away = it }
                }
                Spacer(Modifier.height(8.dp))
                Text("The server then finds the earliest exact prediction.", style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
            }
        },
        confirmButton = { TextButton(onClick = { onSave(home, away) }, enabled = !busy) { Text(if (busy) "Saving..." else "Save Result") } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") } },
    )
}

@Composable
private fun GoalStepper(value: Int, onChange: (Int) -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        FilledTonalIconButton(onClick = { onChange((value + 1).coerceAtMost(30)) }) { Text("+", fontWeight = FontWeight.Bold) }
        Text("$value", fontSize = 26.sp, fontWeight = FontWeight.Black)
        FilledTonalIconButton(onClick = { onChange((value - 1).coerceAtLeast(0)) }) { Text("−", fontWeight = FontWeight.Bold) }
    }
}

@Composable
private fun ReasonDialog(title: String, message: String, confirmLabel: String, busy: Boolean, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var reason by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(title) },
        text = {
            Column {
                Text(message)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(reason, { reason = it.take(300) }, label = { Text("Reason") }, minLines = 2, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = { TextButton(onClick = { onConfirm(reason.trim()) }, enabled = !busy && reason.isNotBlank()) { Text(confirmLabel, color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Back") } },
    )
}

@Composable
private fun PostponeDialog(c: FootballContest, busy: Boolean, onDismiss: () -> Unit, onConfirm: (Date, Date, String) -> Unit) {
    var kickoff by remember { mutableStateOf<Date?>(null) }
    var reason by remember { mutableStateOf("") }
    var picking by remember { mutableStateOf(false) }
    val oldKick = parseApiDate(c.kickoffAt)?.time
    val oldClose = parseApiDate(c.predictionsCloseAt)?.time
    val gap = if (oldKick != null && oldClose != null) (oldKick - oldClose).coerceAtLeast(0) else 0L
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Postpone match") },
        text = {
            Column {
                Text("Existing predictions are kept. Predictions reopen until the new deadline.")
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = { picking = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(kickoff?.let { tr("New kickoff") + ": " + SimpleDateFormat("d MMM yyyy, HH:mm", Locale.US).apply { timeZone = SOMALIA_TZ }.format(it) } ?: tr("Choose new kickoff"))
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(reason, { reason = it.take(200) }, label = { Text("Reason") }, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(onClick = { kickoff?.let { k -> onConfirm(k, Date(k.time - gap), reason.trim().ifBlank { "Postponed" }) } }, enabled = !busy && kickoff != null) { Text("Postpone") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Back") } },
    )
    if (picking) DateTimePickerDialog(initial = kickoff ?: oldKick?.let { Date(it) }, onDismiss = { picking = false }, onPicked = { kickoff = it; picking = false })
}

@Composable
private fun RewardDialog(paid: Boolean, c: FootballContest, busy: Boolean, onDismiss: () -> Unit, onConfirm: (String?, String?) -> Unit) {
    var ref by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(if (paid) "Record reward as paid" else "Record failed attempt") },
        text = {
            Column {
                Text("${c.rewardLabel} · ${c.rewardCompany.name} → ${c.winner?.phone ?: ""}", fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(8.dp))
                if (paid) {
                    OutlinedTextField(ref, { ref = it.take(120) }, label = { Text("Transaction reference (from the SMS)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(8.dp))
                }
                OutlinedTextField(note, { note = it.take(300) }, label = { Text(if (paid) "Note (optional)" else "What went wrong?") }, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(ref.trim().ifBlank { null }, note.trim().ifBlank { null }) },
                enabled = !busy && (!paid || ref.isNotBlank()),
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Back") } },
    )
}

// ---------------- Raadi Macmiil ----------------

@Composable
private fun CustomerSearchPage(onBack: () -> Unit, onOpenContest: (String) -> Unit) {
    var q by rememberSaveable { mutableStateOf("") }
    var result by remember { mutableStateOf<FootballCustomerSearchResponse?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun search() {
        if (q.trim().length < 4) { error = tr("Enter a phone number, customer ID, order ID or prediction ID"); return }
        loading = true
        error = null
        scope.launch {
            try {
                val r = ApiClient.service.searchFootballCustomer(q.trim())
                if (r.isSuccessful) result = r.body() else { result = null; error = footballError(r, tr("No customer found")) }
            } catch (_: Exception) {
                error = tr("Search failed. Check your connection.")
            }
            loading = false
        }
    }

    Scaffold(topBar = { CiyaarahaTopBar("Search Customer", "Phone, customer ID, order ID or prediction ID", onBack) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
            OutlinedTextField(q, { q = it.take(64) }, label = { Text("Search") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            Button(onClick = ::search, enabled = !loading, modifier = Modifier.fillMaxWidth()) { Text(if (loading) "Searching..." else "Search") }
            if (error != null) { Spacer(Modifier.height(8.dp)); Text(error!!, color = MaterialTheme.colorScheme.error) }
            result?.let { res ->
                Spacer(Modifier.height(16.dp))
                Card(shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp)) {
                        Text(res.customer.name.ifBlank { "—" }, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                        LabeledValue("Phone", res.customer.phoneMasked)
                        LabeledValue("Customer ID", res.customer.id)
                        LabeledValue("Member since", somaliaTime(res.customer.memberSince))
                        LabeledValue("Predictions", "${res.predictions.size}")
                        LabeledValue("Wins", "${res.predictions.count { it.outcome == "won" }}")
                    }
                }
                Spacer(Modifier.height(12.dp))
                SectionTitle("Predictions")
                if (res.predictions.isEmpty()) Text("This customer hasn't predicted any match yet.", style = MaterialTheme.typography.bodySmall)
                res.predictions.forEach { p ->
                    Card(shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp).clickable { onOpenContest(p.contestId) }) {
                        Column(Modifier.padding(10.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Filled.SportsSoccer, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(p.match, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(tr(outcomeLabel(p.outcome)), fontWeight = FontWeight.Bold, fontSize = 12.sp,
                                    color = when (p.outcome) { "won" -> Color(0xFF16A34A); "correct_not_first" -> Color(0xFF2563EB); else -> MaterialTheme.colorScheme.onSurfaceVariant })
                            }
                            LabeledValue("Prediction", "${p.home} - ${p.away}")
                            p.officialScore?.let { LabeledValue("Official result", "${it.home} - ${it.away}") }
                            LabeledValue("Submitted", somaliaTime(p.submittedAt))
                            p.rewardStatus?.let { LabeledValue("Reward", tr(winnerStatusLabel(it))) }
                        }
                    }
                }
                if (res.rewards.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
                    SectionTitle("Rewards")
                    res.rewards.forEach { r ->
                        LabeledValue("${r.rewardLabel} · ${tr(if (r.status == "paid") "Paid" else "Failed")}", listOfNotNull(r.transactionRef, somaliaTime(r.createdAt)).joinToString(" · "))
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
