# Add project-specific ProGuard rules here.
# Retrofit/OkHttp/Gson need their model classes kept if minification is
# enabled later (isMinifyEnabled is false by default in this project).
-keepattributes Signature
-keepattributes *Annotation*
-keep class com.dalab.internet.data.** { *; }
-keep class com.dalab.internet.network.** { *; }
-dontwarn okhttp3.**
-dontwarn retrofit2.**
