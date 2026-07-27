package com.dalab.internet.customer.ui

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.data.CustomerOrder
import kotlinx.coroutines.delay

private val DalabGreen = Color(0xFF16A34A)
private val ScreenBg = Color(0xFF0B0F1E)
private val MutedText = Color(0xFF9CA3B8)

/**
 * Shown right after the order is created and the dialer has been opened —
 * replaces navigating straight back to Order Detail, so the customer gets a
 * clear confirmation their payment was recorded and is pending
 * verification, in both English and Somali. Auto-advances after a few
 * seconds, or the customer can tap through immediately.
 */
@Composable
fun PaymentSuccessScreen(order: CustomerOrder, onContinue: () -> Unit) {
    var visible by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(
        targetValue = if (visible) 1f else 0f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessLow),
        label = "checkScale",
    )

    LaunchedEffect(order.id) {
        visible = true
        delay(4000)
        onContinue()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(ScreenBg)
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            modifier = Modifier
                .size(96.dp)
                .scale(scale)
                .clip(CircleShape)
                .background(DalabGreen),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Check, contentDescription = null, tint = Color.White, modifier = Modifier.size(52.dp))
        }

        Spacer(Modifier.height(28.dp))
        Text(
            "✅ Payment Successful",
            color = Color.White,
            fontWeight = FontWeight.Bold,
            fontSize = 22.sp,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(16.dp))
        Text(
            "Your payment has been received successfully.\nPlease wait while we verify your transaction.\nYour order will be activated automatically after verification.",
            color = MutedText,
            fontSize = 14.sp,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(20.dp))
        Text(
            "✅ Lacagta waa lagu guuleystay.\nLacagtaada si guul leh ayaa loo helay.\nFadlan sug inta la xaqiijinayo macaamilkaaga.\nMarka la xaqiijiyo, adeeggaaga si toos ah ayaa loo hawlgelin doonaa.",
            color = MutedText,
            fontSize = 14.sp,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(32.dp))
        Button(
            onClick = onContinue,
            colors = ButtonDefaults.buttonColors(containerColor = DalabGreen),
            shape = RoundedCornerShape(28.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp),
        ) {
            Text("View My Order", color = Color.White, fontWeight = FontWeight.Bold)
        }
    }
}
