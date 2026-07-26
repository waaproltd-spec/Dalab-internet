# Retrofit/OkHttp/Gson need their model classes kept since this build enables
# minification/resource shrinking for release.
-keepattributes Signature
-keepattributes *Annotation*
-keep class com.dalab.internet.customer.data.** { *; }
-keep class com.dalab.internet.customer.network.** { *; }
-dontwarn okhttp3.**
-dontwarn retrofit2.**
