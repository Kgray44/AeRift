package com.kgamazing44.aerift.plugin

import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Matrix
import android.hardware.camera2.CameraCharacteristics
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Size
import android.view.Surface
import android.view.ViewTreeObserver
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.Observer
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** A native-only input provider. The existing GestureIntent owns all decisions. */
internal class AndroidCamera(private val activity: Activity) : Application.ActivityLifecycleCallbacks {
    @InvokeArg
    class StartArgs {
        lateinit var attemptId: String
        lateinit var events: Channel
    }

    @InvokeArg
    class StopArgs {
        lateinit var attemptId: String
    }

    private class Attempt(val id: String, val events: Channel) {
        // The detector and last capture are accessed only by the analysis executor.
        var detector: HandLandmarker? = null
        val captureClock = CameraCaptureClock()
        @Volatile var usesRealtimeTimestamps = false
        val delivery = AtomicBoolean(false)
        var firstFrame = false
        var analysis: ImageAnalysis? = null
        var provider: ProcessCameraProvider? = null
        var camera: Camera? = null
        var observer: Observer<CameraState>? = null
        var timeout: Runnable? = null
    }

    private val context = activity.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private val retired = LinkedHashSet<String>()
    @Volatile private var active: Attempt? = null
    private var focusObserver: ViewTreeObserver? = null
    private var destroyed = false
    private val focusListener = ViewTreeObserver.OnWindowFocusChangeListener { focused ->
        if (!focused) active?.let { finish(it, "suspended") }
    }

    init {
        activity.application.registerActivityLifecycleCallbacks(this)
    }

    fun hasFrontCamera(): Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FRONT)

    fun cameraClock(invoke: Invoke) {
        invoke.resolveObject(mapOf("clockMs" to clockMs()))
    }

    fun startCamera(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(StartArgs::class.java)
        } catch (_: Exception) {
            invoke.reject("Invalid camera attempt.")
            return
        }
        val attemptId = try { args.attemptId } catch (_: UninitializedPropertyAccessException) {
            invoke.reject("Invalid camera attempt.")
            return
        }
        val events = try { args.events } catch (_: UninitializedPropertyAccessException) {
            invoke.reject("Invalid camera channel.")
            return
        }
        if (!validAttemptId(attemptId)) {
            invoke.reject("Invalid camera attempt.")
            return
        }
        activity.runOnUiThread {
            if (destroyed || attemptId in retired) {
                invoke.resolveObject(emptyMap<String, String>())
                return@runOnUiThread
            }
            if (active?.id == attemptId) {
                invoke.resolveObject(emptyMap<String, String>())
                return@runOnUiThread
            }
            val attempt = Attempt(attemptId, events)
            val owner = activity as? LifecycleOwner
            val unavailable = when {
                !hasFrontCamera() || owner == null -> "unavailable"
                active != null -> "busy"
                !isForeground() -> "suspended"
                !hasPermission() -> "denied"
                else -> null
            }
            if (unavailable != null || owner == null) {
                retire(attempt.id)
                state(attempt, unavailable ?: "unavailable")
                invoke.resolveObject(emptyMap<String, String>())
                return@runOnUiThread
            }

            active = attempt
            installFocusObserver()
            state(attempt, "starting")
            invoke.resolveObject(emptyMap<String, String>())
            val startupTimeout = Runnable { finish(attempt, "error") }
            attempt.timeout = startupTimeout
            main.postDelayed(startupTimeout, START_TIMEOUT_MS)
            try {
                analysisExecutor.execute {
                    if (active !== attempt) return@execute
                    try {
                        val options = HandLandmarker.HandLandmarkerOptions.builder()
                            .setBaseOptions(BaseOptions.builder().setModelAssetPath(MODEL).build())
                            .setRunningMode(RunningMode.VIDEO)
                            .setNumHands(2)
                            .setMinHandDetectionConfidence(.6f)
                            .setMinHandPresenceConfidence(.6f)
                            .setMinTrackingConfidence(.6f)
                            .build()
                        attempt.detector = HandLandmarker.createFromOptions(context, options)
                        main.post { bind(attempt, owner) }
                    } catch (_: Exception) {
                        main.post { finish(attempt, "error") }
                    } catch (_: LinkageError) {
                        // Some emulator ABIs omit the Tasks JNI library. Manual transfer remains usable.
                        main.post { finish(attempt, "unavailable") }
                    }
                }
            } catch (_: Exception) {
                finish(attempt, "error")
            }
        }
    }

    fun stopCamera(invoke: Invoke) {
        val id = try { invoke.parseArgs(StopArgs::class.java).attemptId } catch (_: Exception) {
            invoke.reject("Invalid camera attempt.")
            return
        }
        if (!validAttemptId(id)) {
            invoke.reject("Invalid camera attempt.")
            return
        }
        activity.runOnUiThread {
            // A delayed stop may only stop its own capture, never the next attempt.
            retire(id)
            active?.takeIf { it.id == id }?.let { finish(it, null) }
            invoke.resolveObject(emptyMap<String, String>())
        }
    }

    private fun bind(attempt: Attempt, owner: LifecycleOwner) {
        if (active !== attempt) return
        if (!isForeground() || !hasPermission()) {
            finish(attempt, if (hasPermission()) "suspended" else "denied")
            return
        }
        try {
            val pending = ProcessCameraProvider.getInstance(context)
            pending.addListener({
                if (active !== attempt) return@addListener
                if (!isForeground() || !hasPermission()) {
                    finish(attempt, if (hasPermission()) "suspended" else "denied")
                    return@addListener
                }
                try {
                    val provider = pending.get()
                    val selector = CameraSelector.DEFAULT_FRONT_CAMERA
                    if (!provider.hasCamera(selector)) {
                        finish(attempt, "unavailable")
                        return@addListener
                    }
                    val resolution = ResolutionSelector.Builder()
                        .setResolutionStrategy(ResolutionStrategy(Size(640, 480),
                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
                        .build()
                    @Suppress("DEPRECATION")
                    val rotation = activity.windowManager.defaultDisplay?.rotation ?: Surface.ROTATION_0
                    val analysis = ImageAnalysis.Builder()
                        .setResolutionSelector(resolution)
                        .setTargetRotation(rotation)
                        .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                    attempt.provider = provider
                    attempt.analysis = analysis
                    // Bind first to discover the actual camera clock domain before accepting an image.
                    val camera = provider.bindToLifecycle(owner, selector, analysis)
                    attempt.camera = camera
                    attempt.usesRealtimeTimestamps = usesRealtimeTimestamps(camera)
                    analysis.setAnalyzer(analysisExecutor) { image -> analyze(attempt, image) }
                    val observer = Observer<CameraState> { status ->
                        if (active !== attempt) return@Observer
                        val error = status.error?.code
                        when {
                            error == CameraState.ERROR_CAMERA_IN_USE ||
                                error == CameraState.ERROR_MAX_CAMERAS_IN_USE -> finish(attempt, "busy")
                            error == CameraState.ERROR_CAMERA_DISABLED -> finish(attempt, "suspended")
                            error != null -> finish(attempt, "error")
                            attempt.firstFrame && status.type != CameraState.Type.OPEN -> finish(attempt, "suspended")
                        }
                    }
                    attempt.observer = observer
                    camera.cameraInfo.cameraState.observe(owner, observer)
                } catch (_: SecurityException) {
                    finish(attempt, "denied")
                } catch (_: Exception) {
                    finish(attempt, "error")
                }
            }, ContextCompat.getMainExecutor(activity))
        } catch (_: Exception) {
            finish(attempt, "error")
        }
    }

    @OptIn(ExperimentalCamera2Interop::class)
    private fun usesRealtimeTimestamps(camera: Camera): Boolean =
        Camera2CameraInfo.from(camera.cameraInfo)
            .getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE) ==
            CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME

    private fun analyze(attempt: Attempt, image: ImageProxy) {
        var bitmap: Bitmap? = null
        var upright: Bitmap? = null
        var transferredBitmap: Bitmap? = null
        var ownsDelivery = false
        var queued = false
        try {
            if (active !== attempt || !attempt.delivery.compareAndSet(false, true)) return
            ownsDelivery = true
            val capture = attempt.captureClock.accept(image.imageInfo.timestamp,
                SystemClock.elapsedRealtimeNanos(), System.nanoTime(), attempt.usesRealtimeTimestamps)
            if (capture < 0 || image.width !in 1..1920 || image.height !in 1..1920) return
            val detector = attempt.detector ?: return
            bitmap = image.toBitmap()
            val source = checkNotNull(bitmap)
            val degrees = image.imageInfo.rotationDegrees
            val rotated = if (degrees == 0) source else Bitmap.createBitmap(source, 0, 0,
                source.width, source.height, Matrix().apply { postRotate(degrees.toFloat()) }, false)
            upright = rotated
            val mediaImage = BitmapImageBuilder(rotated).build()
            transferredBitmap = rotated // MPImage owns it after a successful build.
            val hands = try {
                detector.detectForVideo(mediaImage, capture / 1_000_000).landmarks().take(2).map { points ->
                    // MediaPipe returns the shared 21 joints in top-left origin. Handedness
                    // is not confidence, and normalized landmarks need no artificial score.
                    if (points.size != 21 || points.any { !it.x().isFinite() || !it.y().isFinite() || !it.z().isFinite() }) {
                        emptyList()
                    } else points.map { mapOf("x" to it.x(), "y" to it.y(), "z" to it.z()) }
                }
            } finally {
                mediaImage.close()
            }
            val frame = mapOf("captureMs" to capture / 1_000_000.0, "width" to rotated.width,
                "height" to rotated.height, "hands" to hands)
            queued = main.post {
                try {
                    if (active !== attempt) return@post
                    if (!isForeground() || !hasPermission()) {
                        finish(attempt, if (hasPermission()) "suspended" else "denied")
                        return@post
                    }
                    if (!CameraCaptureClock.isFresh(capture, SystemClock.elapsedRealtimeNanos())) return@post
                    if (!attempt.firstFrame) {
                        attempt.firstFrame = true
                        attempt.timeout?.let { main.removeCallbacks(it) }
                        val deadline = Runnable { finish(attempt, "disabled") }
                        attempt.timeout = deadline
                        main.postDelayed(deadline, MAX_ATTEMPT_MS)
                        state(attempt, "ready")
                    }
                    emit(attempt, mapOf("type" to "frame", "attemptId" to attempt.id, "frame" to frame))
                } finally {
                    attempt.delivery.set(false)
                }
            }
        } catch (_: Exception) {
            main.post { finish(attempt, "error") }
        } catch (_: LinkageError) {
            main.post { finish(attempt, "unavailable") }
        } finally {
            if (upright !== bitmap && upright !== transferredBitmap) upright?.recycle()
            if (bitmap !== transferredBitmap) bitmap?.recycle()
            image.close()
            if (ownsDelivery && !queued) attempt.delivery.set(false)
        }
    }

    private fun state(attempt: Attempt, name: String) =
        emit(attempt, mapOf("type" to "state", "attemptId" to attempt.id, "state" to name))

    private fun emit(attempt: Attempt, payload: Map<String, Any>) {
        try {
            attempt.events.sendObject(payload)
        } catch (_: Exception) {
            finish(attempt, null)
        }
    }

    private fun finish(attempt: Attempt, terminal: String?) {
        if (active !== attempt) return
        active = null
        retire(attempt.id)
        attempt.timeout?.let { main.removeCallbacks(it) }
        attempt.observer?.let { attempt.camera?.cameraInfo?.cameraState?.removeObserver(it) }
        attempt.analysis?.let { analysis ->
            runCatching { analysis.clearAnalyzer() }
            runCatching { attempt.provider?.unbind(analysis) }
        }
        // Serial executor means all outstanding native inference has returned before close.
        analysisExecutor.execute {
            runCatching { attempt.detector?.close() }
            attempt.detector = null
        }
        if (terminal != null) state(attempt, terminal)
    }

    private fun retire(id: String) {
        retired.add(id)
        if (retired.size > 32) retired.remove(retired.first())
    }

    private fun installFocusObserver() {
        if (focusObserver?.isAlive == true) return
        val viewTree = activity.window.decorView.viewTreeObserver
        if (viewTree.isAlive) {
            viewTree.addOnWindowFocusChangeListener(focusListener)
            focusObserver = viewTree
        }
    }

    private fun hasPermission() =
        ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun isForeground(): Boolean = !activity.isFinishing && !activity.isDestroyed &&
        activity.hasWindowFocus() && activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT &&
        (activity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true

    fun destroy() {
        activity.runOnUiThread {
            if (destroyed) return@runOnUiThread
            destroyed = true
            active?.let { finish(it, "suspended") }
            focusObserver?.takeIf { it.isAlive }?.removeOnWindowFocusChangeListener(focusListener)
            focusObserver = null
            activity.application.unregisterActivityLifecycleCallbacks(this)
            analysisExecutor.shutdown()
        }
    }

    override fun onActivityPaused(owner: Activity) {
        if (owner === activity) active?.let { finish(it, "suspended") }
    }
    override fun onActivityStopped(owner: Activity) {
        if (owner === activity) active?.let { finish(it, "suspended") }
    }
    override fun onActivityDestroyed(owner: Activity) {
        if (owner === activity) destroy()
    }
    override fun onActivityCreated(owner: Activity, state: Bundle?) = Unit
    override fun onActivityStarted(owner: Activity) = Unit
    override fun onActivityResumed(owner: Activity) = Unit
    override fun onActivitySaveInstanceState(owner: Activity, state: Bundle) = Unit

    companion object {
        private const val MODEL = "hand_landmarker.task"
        private const val START_TIMEOUT_MS = 6_000L
        private const val MAX_ATTEMPT_MS = 30_000L
        private fun clockMs() = SystemClock.elapsedRealtimeNanos() / 1_000_000.0
        private fun validAttemptId(id: String) = id.isNotEmpty() && id.length <= 96 &&
            id.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' || it == '_' }
    }
}
