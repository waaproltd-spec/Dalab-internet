package com.dalab.internet.auth

import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

/**
 * SystemBrand.logo() once called itself for "dalab" (a find-and-replace
 * hit the helper too) and crashed the app with a StackOverflowError the
 * moment Home drew the logo. The helper must only map keys to drawables.
 */
class SystemBrandTest {
    @Test
    fun logoNeverCallsItself() {
        val file = listOf(
            File("src/main/java/com/dalab/internet/auth/SystemBrand.kt"),
            File("app/src/main/java/com/dalab/internet/auth/SystemBrand.kt"),
            File("waapro-agent-app/app/src/main/java/com/dalab/internet/auth/SystemBrand.kt"),
        ).first { it.exists() }
        val body = file.readText().substringAfter("fun logo()")
        assertFalse("SystemBrand.logo() must not call itself", body.contains("logo()"))
    }
}
