# Retrofit/OkHttp/Gson need their model classes kept since this build enables
# minification/resource shrinking for release.
-keepattributes Signature
-keepattributes *Annotation*
-keep class com.dalab.internet.customer.data.** { *; }
-keep class com.dalab.internet.customer.network.** { *; }
-dontwarn okhttp3.**
-dontwarn retrofit2.**

# google-crypto-tink (used by androidx.security.crypto for EncryptedSharedPreferences)
# references these annotation-only classes at compile time; they're not on the
# runtime classpath and aren't needed at runtime, so R8 can safely ignore them.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
