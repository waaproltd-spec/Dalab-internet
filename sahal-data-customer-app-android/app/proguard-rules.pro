# Retrofit/OkHttp/Gson need their model classes kept since this build enables
# minification/resource shrinking for release.
-keepattributes Signature
-keepattributes *Annotation*
-keep class com.sahal.data.customer.data.** { *; }
-keep class com.sahal.data.customer.network.** { *; }
-dontwarn okhttp3.**
-dontwarn retrofit2.**

# google-crypto-tink (used by androidx.security.crypto for EncryptedSharedPreferences)
# references these annotation-only classes at compile time; they're not on the
# runtime classpath and aren't needed at runtime, so R8 can safely ignore them.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**

# Tink registers its AEAD/cipher primitives via reflection at runtime (Registry/
# Config classes) — without this keep, R8 can rename/strip pieces of that
# registration path even though the build itself succeeds, and
# EncryptedSharedPreferences.create() throws the first time it's actually
# called at app startup, crashing before any UI shows. This is the standard
# fix Google's own security-crypto samples ship for release/minified builds.
-keep class com.google.crypto.tink.** { *; }
-keep interface com.google.crypto.tink.** { *; }
-dontwarn com.google.crypto.tink.**
