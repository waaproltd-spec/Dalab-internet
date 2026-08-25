plugins {
    id("com.android.application") version "8.5.0" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
    // Applied conditionally in app/build.gradle.kts (only once google-services.json
    // actually exists there) -- declaring the version here regardless is required
    // either way so Gradle can resolve it when the file shows up. Same pattern as
    // agent-app/build.gradle.kts.
    id("com.google.gms.google-services") version "4.4.2" apply false
}
