plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.dalab.internet.customer"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dalab.internet"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "1.0.2"
    }

    signingConfigs {
        // Populated from env vars in CI (see .github/workflows/build-apk.yml);
        // release signing is skipped locally if these aren't set, which just
        // falls back to an unsigned release build.
        create("release") {
            val storeFilePath = System.getenv("CUSTOMER_KEYSTORE_PATH")
            if (!storeFilePath.isNullOrBlank()) {
                storeFile = file(storeFilePath)
                storePassword = System.getenv("CUSTOMER_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("CUSTOMER_KEY_ALIAS")
                keyPassword = System.getenv("CUSTOMER_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (!System.getenv("CUSTOMER_KEYSTORE_PATH").isNullOrBlank()) {
                signingConfig = signingConfigs.getByName("release")
            }
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

    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")

    // Recommended upgrade over plain SharedPreferences for SessionManager's tokens:
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Only remote images this app loads are Super Admin-uploaded promo
    // banners (Home screen carousel) — every other image (provider logos)
    // is a bundled local drawable, so this is the one place async image
    // loading/caching is actually needed.
    implementation("io.coil-kt:coil-compose:2.6.0")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
}
