package com.dalab.internet.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.dalab.internet.R

/**
 * The one Dalab logo asset this app already ships (the launcher icon,
 * res/mipmap/ic_launcher.png -- same "D" wifi-swoosh mark used everywhere
 * else: Customer App's DalabLogo widget, the Admin Dashboard header, the
 * Play Store listing), reused here for in-app branding rather than adding a
 * second logo asset/component system. Rounded-square treatment at a 0.28x
 * corner-radius fraction matches the Customer App's DalabLogo widget
 * exactly, for a consistent mark across both apps.
 */
@Composable
fun DalabLogo(size: Dp = 40.dp, modifier: Modifier = Modifier) {
    Image(
        painter = painterResource(R.mipmap.ic_launcher),
        contentDescription = "Dalab",
        modifier = modifier.size(size).clip(RoundedCornerShape(size * 0.28f)),
    )
}
