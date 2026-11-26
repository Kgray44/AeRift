package com.kgamazing44.aerift.plugin

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import app.tauri.PermissionState
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@InvokeArg class DiscoveryArgs {
    lateinit var id: String
    lateinit var name: String
    var port: Int = 0
    lateinit var events: Channel
}

@InvokeArg class PickerArgs {
    var source: String? = null
    var limit: Int = 1
    var persist: Boolean = false
}

@InvokeArg class TextArgs {
    lateinit var name: String
    lateinit var text: String
}

@InvokeArg class AssetArgs { lateinit var assetId: String }
@InvokeArg class PresentationArgs {
    lateinit var path: String
    lateinit var name: String
    lateinit var action: String
}
@InvokeArg class BrowserArgs { lateinit var url: String }
@InvokeArg class CameraPermissionArgs { var request: Boolean = false }
@InvokeArg class InitializeIdentityArgs { lateinit var candidate: String }
@InvokeArg class TrustArgs { lateinit var value: String }

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.CAMERA], alias = "camera")])
class AeriftAndroidPlugin(private val activity: Activity) : Plugin(activity) {
    private val io = Executors.newSingleThreadExecutor()
    private val secretIo = Executors.newSingleThreadExecutor()
    private val pending = ConcurrentHashMap<Long, Invoke>()
    private val closed = AtomicBoolean()
    private val files = AndroidWorkspaceFiles(activity.applicationContext)
    private val secrets = AndroidSecretFiles(activity.applicationContext)
    private val discovery = AndroidPeerDiscovery(activity.applicationContext)
    private val camera = AndroidCamera(activity)
    private val systemChooser = AtomicBoolean()
    private val thumbnailForeground = AtomicBoolean()
    private var browserSession: BrowserCollection.Session? = null
    private val clipboard get() = requireNotNull(activity.getSystemService(ClipboardManager::class.java))

    override fun load(webView: WebView) {
        if (coldCleanup.compareAndSet(false, true)) {
            io.execute { files.cleanupStagingOnColdStart(); files.cleanupStale() }
        }
    }

    override fun onPause(activity: AppCompatActivity) {
        if (activity === this.activity) {
            thumbnailForeground.set(false)
            discovery.foreground(false)
        }
    }

    override fun onResume(activity: AppCompatActivity) {
        if (activity === this.activity) {
            thumbnailForeground.set(true)
            discovery.foreground(true)
        }
    }

    override fun onDestroy(activity: AppCompatActivity) {
        if (activity !== this.activity) return
        if (!closed.compareAndSet(false, true)) return
        browserSession?.cancel()
        browserSession = null
        camera.destroy()
        discovery.dispose()
        io.shutdownNow()
        secretIo.shutdownNow()
        pending.values.forEach { reject(it, "Android activity closed") }
    }

    @Command fun storageDirectories(invoke: Invoke) = background(invoke) {
        objectOf("staging" to files.staging.absolutePath, "published" to files.published.absolutePath, "partials" to files.partials.absolutePath)
    }

    @Command fun loadIdentity(invoke: Invoke) = background(invoke, secretIo) { objectOf("value" to secrets.load("identity")) }
    @Command fun loadTrust(invoke: Invoke) = background(invoke, secretIo) { objectOf("value" to secrets.load("trust")) }
    @Command fun initializeIdentity(invoke: Invoke) = background(invoke, secretIo) {
        objectOf("value" to secrets.initializeIdentity(invoke.parseArgs(InitializeIdentityArgs::class.java).candidate))
    }
    @Command fun replaceTrust(invoke: Invoke) = background(invoke, secretIo) {
        secrets.replaceTrust(invoke.parseArgs(TrustArgs::class.java).value)
        JSObject()
    }

    @Command fun startDiscovery(invoke: Invoke) = foreground(invoke) {
        val args = invoke.parseArgs(DiscoveryArgs::class.java)
        discovery.start(AndroidPeerDiscovery.Request(args.id, args.name, args.port, args.events))
        resolve(invoke, JSObject())
    }

    @Command fun stopDiscovery(invoke: Invoke) = foreground(invoke) {
        discovery.dispose()
        resolve(invoke, JSObject())
    }

    @Command fun pickFile(invoke: Invoke) = startPicker(invoke, false)
    @Command fun importMedia(invoke: Invoke) = startPicker(invoke, true)
    @Command fun listMedia(invoke: Invoke) = background(invoke) { objectOf("items" to files.list()) }
    @Command fun stageMedia(invoke: Invoke) = background(invoke) {
        objectOf("selection" to files.stageMedia(invoke.parseArgs(AssetArgs::class.java).assetId).wire())
    }
    @Command fun thumbnailMedia(invoke: Invoke) = background(invoke) {
        check(thumbnailForeground.get() && !systemChooser.get())
        val jpeg = files.thumbnail(invoke.parseArgs(AssetArgs::class.java).assetId)
        check(thumbnailForeground.get())
        objectOf("jpeg" to android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP))
    }
    @Command fun removeMedia(invoke: Invoke) = background(invoke) {
        objectOf("items" to files.remove(invoke.parseArgs(AssetArgs::class.java).assetId))
    }
    @Command fun stageText(invoke: Invoke) = background(invoke) {
        val args = invoke.parseArgs(TextArgs::class.java)
        objectOf("selection" to files.stageText(args.name, args.text).wire())
    }

    private fun startPicker(invoke: Invoke, durable: Boolean) = foreground(invoke) {
        val args = invoke.parseArgs(PickerArgs::class.java)
        val source = args.source ?: "files"
        require(source == "files" || source == "photos")
        val limit = if (durable) maximumPickerItems else 1
        val intent = if (source == "photos") {
            val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)
            if (limit > 1) ActivityResultContracts.PickMultipleVisualMedia(limit).createIntent(activity, request)
            else ActivityResultContracts.PickVisualMedia().createIntent(activity, request)
        } else {
            Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, limit > 1)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
        launchChooser(invoke, intent, if (durable) "mediaImported" else "filePicked")
    }

    @ActivityCallback fun filePicked(invoke: Invoke, result: ActivityResult) {
        systemChooser.set(false)
        if (!pending.containsKey(invoke.id)) return
        background(invoke) {
            val uris = pickedUris(result, 1)
            objectOf("selections" to JSONArray(uris.map { files.stageUri(it).wire() }))
        }
    }

    @ActivityCallback fun mediaImported(invoke: Invoke, result: ActivityResult) {
        systemChooser.set(false)
        if (!pending.containsKey(invoke.id)) return
        background(invoke) {
            val uris = pickedUris(result, maximumPickerItems)
            objectOf("items" to if (uris.isEmpty()) files.list() else files.import(uris))
        }
    }

    private fun pickedUris(result: ActivityResult, limit: Int): List<Uri> {
        if (result.resultCode != Activity.RESULT_OK) return emptyList()
        val data = result.data ?: return emptyList()
        val uris = linkedSetOf<Uri>()
        data.clipData?.let { clip ->
            // Do not trust providers to enforce requested limits, or enumerate unbounded items.
            require(clip.itemCount <= limit)
            for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(uris::add)
        }
        data.data?.let(uris::add)
        require(uris.size <= limit)
        return uris.toList()
    }

    @Command fun presentSelection(invoke: Invoke) = foreground(invoke) {
        val args = invoke.parseArgs(PresentationArgs::class.java)
        require(args.action in setOf("preview", "export", "share"))
        val file = files.checkedPresentation(args.path)
        val name = files.safeName(args.name)
        val mime = files.mime(name)
        if (args.action == "export") {
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = mime
                putExtra(Intent.EXTRA_TITLE, name)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            launchChooser(invoke, intent, "documentCreated")
        } else {
            io.execute {
                try {
                    val uri = files.previewUri(file, name)
                    if (!pending.containsKey(invoke.id)) return@execute
                    foreground(invoke) {
                        val intent = if (args.action == "preview") Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                        else Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        intent.clipData = ClipData.newRawUri(name, uri)
                        // The grant goes only to the viewer/target the user chooses.
                        activity.startActivity(Intent.createChooser(intent, if (args.action == "preview") "Open attachment" else "Share attachment"))
                        resolve(invoke, JSObject())
                    }
                } catch (_: Exception) { reject(invoke, "Attachment unavailable") }
            }
        }
    }

    @ActivityCallback fun documentCreated(invoke: Invoke, result: ActivityResult) {
        systemChooser.set(false)
        if (!pending.containsKey(invoke.id)) return
        background(invoke) {
            val uri = result.data?.data
            if (result.resultCode == Activity.RESULT_OK && uri != null) {
                val args = invoke.parseArgs(PresentationArgs::class.java)
                files.export(files.checkedPresentation(args.path), uri)
            }
            JSObject()
        }
    }

    @Command fun clipboardImageAvailable(invoke: Invoke) = foreground(invoke) {
        // Description only: do not read another app's clipboard item until the user requests paste.
        val desc = if (activity.hasWindowFocus()) clipboard.primaryClipDescription else null
        resolve(invoke, objectOf("available" to (desc?.hasMimeType("image/*") == true && !isSensitive(desc))))
    }

    @Command fun pasteClipboardImage(invoke: Invoke) = foreground(invoke) {
        if (!activity.hasWindowFocus()) { resolve(invoke, objectOf("selection" to null)); return@foreground }
        val description = clipboard.primaryClipDescription
        if (description?.hasMimeType("image/*") != true || isSensitive(description)) {
            resolve(invoke, objectOf("selection" to null)); return@foreground
        }
        val clip = clipboard.primaryClip
        if (clip == null || clip.itemCount != 1 || isSensitive(clip.description)) {
            resolve(invoke, objectOf("selection" to null)); return@foreground
        }
        val uri = clip.getItemAt(0).uri
        background(invoke) {
            objectOf("selection" to uri?.takeIf { activity.contentResolver.getType(it)?.startsWith("image/") == true }
                ?.let(files::stageUri)?.wire())
        }
    }

    private fun isSensitive(desc: ClipDescription?): Boolean =
        desc?.extras?.getBoolean("android.content.extra.IS_SENSITIVE", false) == true

    @Command fun openBrowser(invoke: Invoke) = foreground(invoke) {
        check(!systemChooser.get())
        val uri = requireNotNull(BrowserCollection.url(invoke.parseArgs(BrowserArgs::class.java).url))
        val provider = BrowserCollection.packageName(activity)
        if (provider != null) {
            val session = BrowserCollection.start(activity)
            browserSession = session
            try {
                launchChooser(invoke, session.intent(provider, uri), "browserClosed")
                return@foreground
            } catch (_: android.content.ActivityNotFoundException) {
                session.cancel()
                browserSession = null
            } catch (e: Exception) {
                session.cancel()
                browserSession = null
                throw e
            }
        }
        // An ordinary browser has no collection action, and does not keep the invoke open.
        activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        resolve(invoke, objectOf("links" to JSONArray()))
    }

    @ActivityCallback fun browserClosed(invoke: Invoke, @Suppress("UNUSED_PARAMETER") result: ActivityResult) {
        // A browser generally returns RESULT_CANCELED even after collecting one or more pages.
        val links = browserSession?.cancel().orEmpty()
        browserSession = null
        systemChooser.set(false)
        resolve(invoke, objectOf("links" to JSONArray().apply {
            links.forEach { put(objectOf("url" to it, "title" to null)) }
        }))
    }

    @Command fun cameraPermission(invoke: Invoke) = foreground(invoke) {
        val request = invoke.parseArgs(CameraPermissionArgs::class.java).request
        if (request && camera.hasFrontCamera() && getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", invoke, "cameraPermissionResult")
        } else cameraPermissionResult(invoke)
    }

    @PermissionCallback fun cameraPermissionResult(invoke: Invoke) {
        val status = if (!camera.hasFrontCamera()) "unavailable" else when (getPermissionState("camera")) {
            PermissionState.GRANTED -> "authorized"
            PermissionState.PROMPT -> "notDetermined"
            else -> "denied"
        }
        resolve(invoke, objectOf("status" to status))
    }

    @Command fun cameraClock(invoke: Invoke) = camera.cameraClock(invoke)
    @Command fun startCamera(invoke: Invoke) = camera.startCamera(invoke)
    @Command fun stopCamera(invoke: Invoke) = camera.stopCamera(invoke)

    private fun launchChooser(invoke: Invoke, intent: Intent, callback: String) {
        check(systemChooser.compareAndSet(false, true))
        try {
            startActivityForResult(invoke, intent, callback)
        } catch (t: Throwable) {
            systemChooser.set(false)
            throw t
        }
    }

    private fun track(invoke: Invoke): Boolean {
        if (closed.get()) {
            // A first call after teardown is still owed its native response.
            invoke.reject("Android activity closed")
            return false
        }
        pending.putIfAbsent(invoke.id, invoke)
        if (closed.get()) { reject(invoke, "Android activity closed"); return false }
        return true
    }

    private fun resolve(invoke: Invoke, result: JSObject) {
        if (pending.remove(invoke.id, invoke)) invoke.resolve(result)
    }

    private fun reject(invoke: Invoke, message: String) {
        if (pending.remove(invoke.id, invoke)) invoke.reject(message)
    }

    private fun background(invoke: Invoke, executor: ExecutorService = io, action: () -> JSObject) {
        if (!track(invoke)) return
        try {
            executor.execute {
                if (!pending.containsKey(invoke.id)) return@execute
                try { resolve(invoke, action()) }
                catch (_: Exception) { reject(invoke, "Android operation unavailable") }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) { reject(invoke, "Android activity closed") }
    }

    private fun foreground(invoke: Invoke, action: () -> Unit) {
        if (!track(invoke)) return
        activity.runOnUiThread {
            if (!pending.containsKey(invoke.id)) return@runOnUiThread
            try {
                check(!activity.isFinishing && !activity.isDestroyed)
                action()
            } catch (_: Exception) { reject(invoke, "Android operation unavailable") }
        }
    }

    private fun objectOf(vararg entries: Pair<String, Any?>) = JSObject().apply {
        entries.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) }
    }

    companion object {
        private const val maximumPickerItems = 16
        private val coldCleanup = AtomicBoolean()
    }
}
