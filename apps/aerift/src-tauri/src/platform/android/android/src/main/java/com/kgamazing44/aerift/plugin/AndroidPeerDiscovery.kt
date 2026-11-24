package com.kgamazing44.aerift.plugin

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import app.tauri.plugin.Channel
import app.tauri.plugin.JSObject
import org.json.JSONArray
import java.net.Inet4Address

/** LAN DNS-SD is only a hint: shared Rust pairing authenticates every peer. */
@Suppress("DEPRECATION")
internal class AndroidPeerDiscovery(context: Context) {
    private val main = Handler(Looper.getMainLooper())
    private val connectivity = requireNotNull(context.getSystemService(ConnectivityManager::class.java))
    private val nsd = requireNotNull(context.getSystemService(NsdManager::class.java))
    private val pattern = Regex("[0-9a-f]{64}")
    private val knownPlatforms = setOf("windows", "ios", "android", "macos", "linux")
    private val type = "_aerift._tcp."
    private val limit = 256
    private val liveNetworks = linkedSetOf<Network>()
    private var active = true
    private var generation = 0L
    private var published = false
    private var browsing = false
    private var running = false
    private var resolving = false
    private var request: Request? = null
    private var registration: NsdManager.RegistrationListener? = null
    private var browse: NsdManager.DiscoveryListener? = null
    private val pending = linkedMapOf<String, NsdServiceInfo>()
    private val current = linkedMapOf<String, NsdServiceInfo>()
    private val resolved = linkedMapOf<String, JSObject>()

    data class Request(val id: String, val name: String, val port: Int, val events: Channel)

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            main.post {
                if (eligible(caps)) liveNetworks.add(network)
                else if (liveNetworks.remove(network)) settle("suspended")
                reconcile(false)
            }
        }
        override fun onLost(network: Network) {
            main.post {
                if (liveNetworks.remove(network)) {
                    settle("suspended")
                    reconcile(false)
                }
            }
        }
    }
    private var observing = false
    private fun eligible(caps: NetworkCapabilities) = !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
        (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))

    fun start(value: Request) {
        require(pattern.matches(value.id) && value.port in 1..65535 &&
            value.name.toByteArray().size in 1..96 && value.name.none(Char::isISOControl))
        if (!observing) {
            val filter = NetworkRequest.Builder().apply {
                if (Build.VERSION.SDK_INT >= 30) clearCapabilities()
                else {
                    // Do not gate LAN use on an uplink or a validated internet connection.
                    removeCapability(NetworkCapabilities.NET_CAPABILITY_TRUSTED)
                    removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)
                }
            }.addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
                .build()
            connectivity.registerNetworkCallback(filter, callback)
            observing = true
            connectivity.allNetworks.forEach { network ->
                if (connectivity.getNetworkCapabilities(network)?.let(::eligible) == true) liveNetworks.add(network)
            }
        }
        if (request != null) settle(null)
        request = value
        reconcile(true)
    }

    fun foreground(value: Boolean) {
        active = value
        if (value) reconcile(false) else settle("suspended")
    }

    fun dispose() {
        settle("suspended")
        request = null
        if (observing) runCatching { connectivity.unregisterNetworkCallback(callback) }
        observing = false
        liveNetworks.clear()
    }

    private fun reconcile(explicit: Boolean) {
        val value = request ?: return
        if (!active || liveNetworks.isEmpty()) {
            settle("suspended")
            return
        }
        if (running) return
        if (!explicit && !observing) return
        begin(value)
    }

    private fun begin(value: Request) {
        val pass = ++generation
        running = true
        emit("starting")
        val info = NsdServiceInfo().apply {
            serviceName = "aerift-${value.id.take(32)}"
            serviceType = type
            port = value.port
            setAttribute("v", "1")
            setAttribute("id", value.id)
            setAttribute("name", value.name)
            setAttribute("platform", "android")
        }
        val reg = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) = dispatch(pass) { published = true; emit() }
            override fun onRegistrationFailed(info: NsdServiceInfo, error: Int) = dispatch(pass) { settle("unavailable") }
            override fun onServiceUnregistered(info: NsdServiceInfo) = Unit
            override fun onUnregistrationFailed(info: NsdServiceInfo, error: Int) = Unit
        }
        registration = reg
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) = dispatch(pass) { browsing = true; emit() }
            override fun onStartDiscoveryFailed(type: String, error: Int) = dispatch(pass) { settle("unavailable") }
            override fun onStopDiscoveryFailed(type: String, error: Int) = Unit
            override fun onDiscoveryStopped(type: String) = Unit
            override fun onServiceFound(info: NsdServiceInfo) = dispatch(pass) {
                if (info.serviceType.trim('.') != type.trim('.') || info.serviceName == "aerift-${value.id.take(32)}") return@dispatch
                val key = serviceKey(info)
                if (key in current || current.size >= limit) return@dispatch
                current[key] = info
                pending[key] = info
                pump(pass, value.id)
            }
            override fun onServiceLost(info: NsdServiceInfo) = dispatch(pass) {
                val key = serviceKey(info)
                current.remove(key)
                pending.remove(key)
                if (resolved.remove(key) != null) emit()
            }
        }
        browse = listener
        try {
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, reg)
            nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (_: SecurityException) {
            settle("disabled")
        } catch (_: RuntimeException) {
            settle("unavailable")
        }
    }

    private fun serviceKey(service: NsdServiceInfo): String {
        val network = if (Build.VERSION.SDK_INT >= 33) service.network?.networkHandle ?: 0L else 0L
        return "$network:${service.serviceName}"
    }

    private fun pump(pass: Long, ownId: String) {
        if (resolving) return
        val next = pending.entries.firstOrNull() ?: return
        val key = next.key
        val item = pending.remove(key) ?: return
        resolving = true
        val callback = object : NsdManager.ResolveListener {
            override fun onResolveFailed(service: NsdServiceInfo, code: Int) = dispatch(pass) {
                resolving = false
                current.remove(key, item)
                pump(pass, ownId)
            }
            override fun onServiceResolved(service: NsdServiceInfo) = dispatch(pass) {
                resolving = false
                if (current[key] === item) {
                    parse(service, ownId)?.let { peer -> resolved[key] = peer; emit() }
                }
                pump(pass, ownId)
            }
        }
        try {
            nsd.resolveService(item, callback)
        } catch (_: RuntimeException) {
            resolving = false
            current.remove(key, item)
            main.post { if (pass == generation) pump(pass, ownId) }
        }
    }

    private fun parse(service: NsdServiceInfo, ownId: String): JSObject? {
        val txt = service.attributes
        fun field(key: String) = txt[key]?.toString(Charsets.UTF_8).orEmpty()
        if (field("v") != "1") return null
        val id = field("id")
        val name = field("name")
        val platform = field("platform")
        if (id == ownId || !pattern.matches(id) || name.isBlank() ||
            name.toByteArray().size > 96 || name.any(Char::isISOControl) ||
            platform !in knownPlatforms || service.port !in 1..65535) return null
        // The app's shared native sessions currently bind IPv4.
        val possible = if (Build.VERSION.SDK_INT >= 34) service.hostAddresses else listOfNotNull(service.host)
        val addresses = possible.filterIsInstance<Inet4Address>().distinct().take(8).filter {
            !it.isAnyLocalAddress && !it.isLoopbackAddress && !it.isMulticastAddress
        }
        if (addresses.isEmpty()) return null
        val endpoints = JSONArray().apply {
            addresses.forEach { address -> put(JSObject().apply {
                put("ip", address.hostAddress)
                put("port", service.port)
                put("scopeId", 0)
            }) }
        }
        return JSObject().apply { put("id", id); put("name", name); put("platform", platform); put("endpoints", endpoints) }
    }

    private fun dispatch(pass: Long, operation: () -> Unit) {
        main.post { if (pass == generation && running) operation() }
    }

    private fun emit(state: String = if (published && browsing) "ready" else "starting") {
        val payload = JSObject().apply {
            put("state", state)
            put("peers", JSONArray().apply {
                if (state == "ready") resolved.values.forEach { put(it) }
            })
        }
        runCatching { request?.events?.send(payload) }
    }

    private fun settle(state: String?) {
        generation++
        browse?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        registration?.let { runCatching { nsd.unregisterService(it) } }
        running = false
        browsing = false
        published = false
        resolving = false
        browse = null
        registration = null
        pending.clear()
        current.clear()
        resolved.clear()
        if (state != null && request != null) emit(state)
    }
}
