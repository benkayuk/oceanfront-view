# JSch (CommaSsh) picks its ciphers, key exchanges and signatures by class name at run time.
-keep class com.jcraft.jsch.** { *; }
# its optional integrations, absent on Android
-dontwarn com.sun.jna.**
-dontwarn org.bouncycastle.**
-dontwarn org.apache.logging.log4j.**
-dontwarn org.slf4j.**
-dontwarn org.newsclub.net.unix.**
-dontwarn com.jcraft.jzlib.**
-dontwarn javax.security.auth.**
-dontwarn org.ietf.jgss.**
