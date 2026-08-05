# Add project-specific ProGuard rules here.
# Retrofit/OkHttp/Gson need their model classes kept since isMinifyEnabled
# is true for the release build type.
-keepattributes Signature
-keepattributes *Annotation*
-keep class com.sahal.data.data.** { *; }
-keep class com.sahal.data.network.** { *; }
-dontwarn okhttp3.**
-dontwarn retrofit2.**

# androidx.security:security-crypto pulls in Google Tink, whose
# compile-time-only annotations (error-prone, checker-framework, JSR-305)
# aren't on the runtime classpath. R8 treats referencing an absent class as
# an error unless told it's fine to leave unresolved — these annotations
# are never used at runtime, so it is.
-dontwarn com.google.errorprone.annotations.**
-dontwarn org.checkerframework.**
-dontwarn javax.annotation.**
