plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    // Kotlin source package/namespace stays com.dalab.internet — unrelated to
    // the applicationId below, and renaming it would mean touching every
    // source file's package declaration for no reason.
    namespace = "com.dalab.internet"
    compileSdk = 34

    defaultConfig {
        // Was "com.dalab.internet" — identical to the Customer App's Android
        // applicationId. Two different apps sharing one applicationId means
        // Android treats installing either one as an "update" to whichever
        // is already on the device; since they're unrelated apps with
        // different signing keys, that update is always rejected outright
        // ("App not installed"), and the Agent App could never actually get
        // installed on a device that already has the Customer App on it.
        applicationId = "com.dalab.agent"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "1.1.0"
    }

    signingConfigs {
        // A real secret keystore (AGENT_KEYSTORE_* env vars, see
        // agent-app-build-apk.yml) is used when configured; until then this
        // config was empty, so `assembleRelease` silently produced an
        // *unsigned* APK. Android's installer refuses to install an
        // unsigned APK on any device — that's exactly the "won't install on
        // other phones" report. Falling back to a committed, persistent
        // release keystore instead means `assembleRelease` always produces
        // a signed, installable APK. This app is only ever sideloaded onto
        // agent phones directly (never published to the Play Store), so
        // keeping the signing key in the repo is an acceptable tradeoff —
        // the same one already made for the debug keystore just below.
        create("release") {
            val storeFilePath = System.getenv("AGENT_KEYSTORE_PATH")
            if (!storeFilePath.isNullOrBlank()) {
                storeFile = file(storeFilePath)
                storePassword = System.getenv("AGENT_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("AGENT_KEY_ALIAS")
                keyPassword = System.getenv("AGENT_KEY_PASSWORD")
            } else {
                storeFile = file("release.keystore")
                storePassword = "dalabagent123"
                keyAlias = "dalabagent"
                keyPassword = "dalabagent123"
            }
        }
        // Without this, AGP falls back to auto-generating ~/.android/debug.keystore
        // on whatever machine is building — fine locally where that file persists,
        // but CI runners are ephemeral, so every workflow run got a brand-new random
        // debug key and every debug APK became unable to update the last one
        // ("App not installed"). A committed, fixed debug key (standard
        // androiddebugkey/android credentials — not a secret, every default debug
        // keystore uses the same ones) keeps every debug build's signature stable.
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.compose.material3:material3:1.2.1")
    implementation("androidx.compose.material:material-icons-extended:1.6.7")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")
    // Backstop for AgentBackgroundService: survives process death outside of a
    // reboot (Doze/OEM kill) since WorkManager's own scheduler can restart it
    // even when the app's own process is gone.
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")

    // Recommended upgrade over plain SharedPreferences for SessionManager's tokens:
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
}
