package ai.sunnypilot.webhud

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject

/**
 * The screen's own location, for cars whose telematics box gives no position: the page's *This screen*
 * position source (Settings → Display → Road → Position). It runs only while the page asks for it and the
 * HUD is on screen ([MainActivity]). Each fix goes to the page as JSON, {lat, lon, acc?, speed?, bearing?,
 * at, provider}, where `at` is when the fix was taken on the wall clock (the page's Date.now()), worked out
 * from the fix's elapsedRealtimeNanos, so the page's pose estimator knows how late it is.
 */
class DeviceLocation(context: Context, private val onFix: (String) -> Unit) {

    private val app = context.applicationContext
    private val lm = app.getSystemService(LocationManager::class.java)
    private var provider: String? = null

    // every method spelled out: before Android 10 the framework calls the ones that later got defaults
    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) = onFix(json(location))
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
        @Deprecated("Called only before Android 10")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    }

    val running get() = provider != null

    fun hasPermission() = PERMISSIONS.any { app.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    /** Starts the updates (on the main looper). Null when they run, else why not, for the page to show. */
    @SuppressLint("MissingPermission")
    fun start(): String? {
        if (provider != null) return null
        if (!hasPermission()) return "No location permission: allow it for the HUD app."
        if (lm == null) return "This screen has no location service."
        val all = lm.allProviders
        // the receiver itself first; on a head unit it may be the car's, through the vehicle HAL
        val candidates = listOfNotNull(LocationManager.GPS_PROVIDER, if (Build.VERSION.SDK_INT >= 31) LocationManager.FUSED_PROVIDER else null,
            LocationManager.NETWORK_PROVIDER).filter { it in all }
        val p = candidates.firstOrNull { lm.isProviderEnabled(it) } ?: candidates.firstOrNull()
            ?: return "This screen has no location provider."
        return try {
            lm.requestLocationUpdates(p, MIN_INTERVAL_MS, 0f, listener, Looper.getMainLooper())
            provider = p
            Log.i(TAG, "device location: on, from $p")
            if (Build.VERSION.SDK_INT >= 28 && !lm.isLocationEnabled) "Location is off on this screen: turn it on in its settings." else null
        } catch (e: Exception) {
            Log.w(TAG, "device location: can't start ($p)", e)
            "Can't get this screen's location: ${e.message}"
        }
    }

    fun stop() {
        if (provider == null) return
        lm?.removeUpdates(listener)
        provider = null
        Log.i(TAG, "device location: off")
    }

    private fun json(l: Location): String {
        val ageMs = (SystemClock.elapsedRealtimeNanos() - l.elapsedRealtimeNanos) / 1_000_000
        return JSONObject().apply {
            put("lat", l.latitude)
            put("lon", l.longitude)
            if (l.hasAccuracy()) put("acc", l.accuracy.toDouble())
            if (l.hasSpeed()) put("speed", l.speed.toDouble())
            if (l.hasBearing()) put("bearing", l.bearing.toDouble())
            put("at", System.currentTimeMillis() - ageMs)
            put("provider", l.provider ?: provider)
        }.toString()
    }

    companion object {
        private const val TAG = "WebHud"
        private const val MIN_INTERVAL_MS = 100L   // as often as the provider gives them (a GNSS receiver: 1-10 Hz)
        val PERMISSIONS = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)

        /** For the page, when there's no fix to send: {error}. */
        fun error(message: String): String = JSONObject().put("error", message).toString()
    }
}
