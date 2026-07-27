package com.dalab.internet.customer.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.ManageAccounts
import androidx.compose.material.icons.filled.Receipt
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.UpdateProfileRequest
import kotlinx.coroutines.launch

private val DalabIndigo = Color(0xFF1D2E8C)
private val DangerRed = Color(0xFFDC2626)
private const val SUPPORT_PHONE = "252610338686"
private const val PACKAGE_NAME = "com.dalab.internet.customer"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(onLogout: () -> Unit, onOpenOrders: () -> Unit) {
    val context = LocalContext.current
    var customer by remember { mutableStateOf(SessionManager.currentCustomer()) }
    var showEditDialog by remember { mutableStateOf(false) }
    var showAccountSheet by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Scaffold(topBar = { TopAppBar(title = { Text("Profile") }) }) { padding ->
        Column(
            modifier = Modifier.padding(padding).fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(24.dp))
            Box(
                modifier = Modifier
                    .size(84.dp)
                    .clip(CircleShape)
                    .background(Color(0xFFE6E9F8)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    (customer?.name?.takeIf { it.isNotBlank() } ?: "?").take(1).uppercase(),
                    color = DalabIndigo,
                    fontWeight = FontWeight.Bold,
                    fontSize = 30.sp,
                )
            }
            Spacer(Modifier.height(12.dp))
            Text(
                customer?.name?.takeIf { it.isNotBlank() } ?: "DALAB customer",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )
            Text(customer?.phone ?: "", style = MaterialTheme.typography.bodyMedium, color = Color.Gray)
            Spacer(Modifier.height(16.dp))

            Button(
                onClick = { showEditDialog = true },
                colors = ButtonDefaults.buttonColors(containerColor = DalabIndigo),
                shape = RoundedCornerShape(24.dp),
            ) {
                Icon(Icons.Filled.Edit, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Edit Profile")
            }

            Spacer(Modifier.height(24.dp))
            Divider()

            ProfileMenuRow(icon = Icons.Filled.Receipt, label = "My Orders", onClick = onOpenOrders)
            ProfileMenuRow(
                icon = Icons.Filled.Call,
                label = "Call Us",
                onClick = {
                    context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$SUPPORT_PHONE")))
                },
            )
            ProfileMenuRow(
                icon = Icons.Filled.Chat,
                label = "WhatsApp",
                onClick = {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$SUPPORT_PHONE")))
                },
            )
            ProfileMenuRow(
                icon = Icons.Filled.Star,
                label = "Rate the App",
                onClick = {
                    try {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$PACKAGE_NAME")))
                    } catch (_: ActivityNotFoundException) {
                        context.startActivity(
                            Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$PACKAGE_NAME"))
                        )
                    }
                },
            )
            ProfileMenuRow(
                icon = Icons.Filled.Share,
                label = "Share with Friends",
                onClick = {
                    val shareIntent = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(
                            Intent.EXTRA_TEXT,
                            "Buy internet packages fast with DALAB Internet: https://play.google.com/store/apps/details?id=$PACKAGE_NAME",
                        )
                    }
                    context.startActivity(Intent.createChooser(shareIntent, "Share DALAB Internet"))
                },
            )
            ProfileMenuRow(
                icon = Icons.Filled.ManageAccounts,
                label = "Manage Account",
                tint = DangerRed,
                onClick = { showAccountSheet = true },
            )

            Spacer(Modifier.weight(1f))
            Spacer(Modifier.height(20.dp))
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

    if (showAccountSheet) {
        Dialog(onDismissRequest = { showAccountSheet = false }) {
            Surface(shape = RoundedCornerShape(20.dp), color = Color.White) {
                Column(modifier = Modifier.padding(vertical = 8.dp)) {
                    AccountActionRow(icon = Icons.Filled.Logout, label = "Log out") {
                        showAccountSheet = false
                        onLogout()
                    }
                    AccountActionRow(icon = Icons.Filled.Delete, label = "Delete Account") {
                        showAccountSheet = false
                        showDeleteConfirm = true
                    }
                }
            }
        }
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
}

@Composable
private fun AccountActionRow(icon: ImageVector, label: String, onClick: () -> Unit) {
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
                .background(DangerRed.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = DangerRed, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.width(16.dp))
        Text(label, fontSize = 15.sp, color = DangerRed)
    }
}

@Composable
private fun ProfileMenuRow(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    tint: Color = DalabIndigo,
    showChevron: Boolean = true,
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
        Text(label, modifier = Modifier.weight(1f), fontSize = 15.sp, color = if (tint == DalabIndigo) Color.Unspecified else tint)
        if (showChevron) {
            Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = Color.Gray)
        }
    }
    Divider()
}
