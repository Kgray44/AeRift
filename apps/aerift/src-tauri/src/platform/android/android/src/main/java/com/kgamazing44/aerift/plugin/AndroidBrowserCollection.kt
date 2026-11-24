package com.kgamazing44.aerift.plugin

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Looper
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsService
import java.net.URI
import java.util.Locale
import java.util.UUID

// This receiver only accepts a browser's explicitly selected URL during one live tab session.
// No extras are trusted, and receiving an action never opens a URL or changes the clipboard.
class AeriftBrowserCollectReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        BrowserCollection.record(intent.action ?: return, intent.dataString ?: return)
    }
}

internal object BrowserCollection {
    private const val actionPrefix = "com.kgamazing44.aerift.COLLECT_LINK."
    private const val maxLinks = 32
    private const val maxUrlLength = 4096
    private var active: Session? = null

    class Session internal constructor(
        val action: String,
        private val pending: PendingIntent,
    ) {
        internal val links = LinkedHashSet<String>()
        fun cancel(): List<String> {
            checkMainThread()
            if (active !== this) return emptyList()
            active = null
            pending.cancel()
            return links.toList().also { links.clear() }
        }

        fun intent(packageName: String, uri: Uri): Intent = CustomTabsIntent.Builder()
            .addMenuItem("Collect in AeRift", pending)
            .build().intent
            .setPackage(packageName)
            .setData(uri)
    }

    @Suppress("DEPRECATION")
    fun packageName(context: Context): String? {
        // Prefer the user's usual browser, then another installed Custom Tabs provider.
        val compatible = context.packageManager
            .queryIntentServices(Intent(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION), 0)
            .mapNotNull { it.serviceInfo?.packageName }.distinct().sorted()
        return CustomTabsClient.getPackageName(context, compatible)
    }

    fun start(context: Context): Session {
        checkMainThread()
        check(active == null)
        val action = actionPrefix + UUID.randomUUID().toString()
        val intent = Intent(context, AeriftBrowserCollectReceiver::class.java).setAction(action)
        // The component and action are prefilled and cannot be replaced by a browser
        // using this capability. The mutable fill-in is needed for the current tab URL.
        val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        return Session(action, PendingIntent.getBroadcast(context, 0, intent, flags)).also { active = it }
    }

    fun record(action: String, data: String) {
        checkMainThread()
        val session = active ?: return
        if (action != session.action || session.links.size >= maxLinks) return
        url(data)?.let { session.links.add(it.toString()) }
    }

    fun url(raw: String): Uri? {
        if (raw.length !in 1..maxUrlLength) return null
        val parsed = try { URI(raw) } catch (_: java.net.URISyntaxException) { return null }
        val scheme = parsed.scheme?.lowercase(Locale.ROOT)
        if ((scheme != "http" && scheme != "https") || parsed.host.isNullOrBlank() ||
            parsed.rawUserInfo != null || parsed.port !in -1..65535) return null
        return Uri.parse(raw).normalizeScheme()
    }

    private fun checkMainThread() = check(Looper.myLooper() == Looper.getMainLooper())
}
