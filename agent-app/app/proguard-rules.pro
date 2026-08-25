# Add project-specific ProGuard rules here.
# Retrofit/OkHttp/Gson need their model classes kept since isMinifyEnabled
# is true for the release build type.
-keepattributes Signature
-keepattributes *Annotation*
-keep class com.dalab.internet.data.** { *; }
-keep class com.dalab.internet.network.** { *; }
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

# Tink registers its AEAD/deterministic-AEAD key managers (used by
# EncryptedSharedPreferences, which SessionManager and PendingActionQueue
# both call unconditionally during app startup) via runtime reflection, not
# static references R8 can see. Without an explicit keep, full-mode R8
# (proguard-android-optimize.txt) can strip or rename those classes, which
# only breaks at runtime on the very first EncryptedSharedPreferences.create()
# call — i.e. an immediate crash on launch in release builds only, since
# debug has no minification.
-keep class com.google.crypto.tink.** { *; }
-keepclassmembers class com.google.crypto.tink.** { *; }
-dontwarn com.google.crypto.tink.**

# Gson's TypeToken subclasses (DiagnosticsLog.listType, PendingActionQueue's
# own listType — both `object : TypeToken<MutableList<...>>() {}`) rely on
# their generic superclass signature surviving at runtime: Gson reflects on
# it via TypeToken.getSuperclassTypeParameter() to recover the type argument.
# -keepattributes Signature above only preserves that attribute on classes
# R8 still keeps as distinct classes; it does not stop R8 merging/removing an
# anonymous TypeToken subclass that has no members of its own, which is
# exactly the optimization that was collapsing these two. When that happens,
# Gson throws IllegalStateException("TypeToken must be created with a type
# argument...") the instant the anonymous subclass is loaded — for
# DiagnosticsLog that is the very first line of DalabAgentApp.onCreate(),
# i.e. an unconditional crash on every launch of the release build.
-keep,allowobfuscation,allowshrinking class com.google.gson.reflect.TypeToken
-keep,allowobfuscation,allowshrinking class * extends com.google.gson.reflect.TypeToken
