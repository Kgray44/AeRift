package com.kgamazing44.aerift.plugin

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import app.tauri.plugin.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID

class AeriftTransferProvider : FileProvider()

internal class AndroidWorkspaceFiles(private val context: Context) {
    val staging = directory(context.cacheDir, "aerift-staging")
    val published = directory(context.filesDir, "aerift-received")
    val partials = directory(context.filesDir, "aerift-receive-partials")
    private val previews = directory(context.cacheDir, "aerift-preview")
    private val durable = directory(context.noBackupFilesDir, "aerift-media")
    private val maxBytes = 512L * 1024 * 1024
    private val maxItems = 256
    private val resolver = context.contentResolver

    data class Item(val path: File, val name: String, val size: Long, val kind: String) {
        fun wire() = JSObject().apply {
            put("path", path.absolutePath); put("name", name)
            put("sizeBytes", size); put("kind", kind)
        }
    }

    fun cleanupStale() {
        val cutoff = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
        for (root in listOf(staging, previews, durable))
            root.listFiles().orEmpty().take(maxItems * 3).filter {
                it.isDirectory && it.lastModified() < cutoff &&
                    (root == previews || (root == durable && it.name.startsWith(".import-")))
            }.forEach { it.deleteRecursively() }
    }

    // Called only once on host initialization before Rust has issued any leases.
    fun cleanupStagingOnColdStart() {
        staging.listFiles().orEmpty().take(maxItems * 3).filter {
            it.isDirectory && runCatching { UUID.fromString(it.name) }.isSuccess
        }.forEach { it.deleteRecursively() }
    }

    fun stageUri(uri: Uri): Item {
        require(uri.scheme == ContentResolver.SCHEME_CONTENT)
        val (name, kind) = providerInfo(uri)
        return stage(name, kind) { resolver.openInputStream(uri) ?: error("Input unavailable") }
    }

    fun stageText(name: String, text: String): Item {
        val data = text.toByteArray(Charsets.UTF_8)
        require(data.isNotEmpty() && data.size <= 128 * 1024)
        return stage(safeName(name), "file") { data.inputStream() }
    }

    private fun stage(name: String, kind: String, input: () -> InputStream): Item {
        val existing = staging.listFiles().orEmpty()
        require(existing.size < maxItems)
        var budget = maxBytes
        for (child in existing) for (f in child.listFiles().orEmpty()) if (f.isFile) budget -= f.length()
        require(budget >= 0)
        val holder = directory(staging, UUID.randomUUID().toString())
        val output = File(holder, name)
        try {
            val size = input().use { stream -> output.outputStream().use { copyBounded(stream, it, budget) } }
            return Item(output, name, size, kind)
        } catch (t: Throwable) {
            holder.deleteRecursively()
            throw t
        }
    }

    private fun providerInfo(uri: Uri): Pair<String, String> {
        val mime = resolver.getType(uri)?.lowercase().orEmpty()
        val candidate = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst() && !it.isNull(0)) it.getString(0) else null
        }
        val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)
        val name = safeName(candidate ?: if (extension.isNullOrBlank()) "Attachment" else "Attachment.$extension")
        val kind = when {
            mime.startsWith("image/") -> "photo"
            mime.startsWith("video/") -> "video"
            else -> "file"
        }
        return name to kind
    }

    fun list(): JSONArray = JSONArray().apply {
        for (parent in durable.listFiles().orEmpty().take(maxItems).sortedByDescending(File::lastModified)) {
            val record = readRecord(parent) ?: continue
            put(record)
        }
    }

    fun import(uris: List<Uri>): JSONArray {
        var budget = maxBytes
        val existing = list()
        require(existing.length() + uris.size <= maxItems)
        for (index in 0 until existing.length()) budget -= existing.getJSONObject(index).getLong("sizeBytes")
        val committed = mutableListOf<File>()
        val prepared = mutableListOf<File>()
        try {
            for (uri in uris) {
                require(uri.scheme == ContentResolver.SCHEME_CONTENT)
                val id = UUID.randomUUID().toString()
                val parent = directory(durable, ".import-$id")
                prepared += parent
                val (name, kind) = providerInfo(uri)
                val bytes = (resolver.openInputStream(uri) ?: error("Input unavailable")).use { input ->
                    File(parent, "data").outputStream().use { copyBounded(input, it, budget) }
                }
                budget -= bytes
                File(parent, "info.json").writeText(JSObject().apply {
                    put("id", id); put("name", name); put("kind", kind); put("sizeBytes", bytes)
                }.toString())
            }
            for (parent in prepared) {
                val final = File(durable, parent.name.removePrefix(".import-"))
                check(parent.renameTo(final))
                committed += final
            }
        } catch (t: Throwable) {
            (prepared + committed).forEach { it.deleteRecursively() }
            throw t
        }
        return list()
    }

    // Only the app-private import catalog can issue a thumbnail source.
    fun thumbnail(assetId: String): ByteArray = ImportedPhotoThumbnail.make(durable, assetId)

    fun stageMedia(assetId: String): Item {
        val parent = asset(assetId)
        val record = readRecord(parent) ?: error("Media unavailable")
        val name = record.getString("name")
        return stage(name, record.getString("kind")) { FileInputStream(File(parent, "data")) }
    }

    fun remove(assetId: String): JSONArray {
        val parent = asset(assetId)
        if (parent.exists()) check(parent.deleteRecursively())
        return list()
    }

    fun checkedPresentation(path: String): File {
        val file = File(path).canonicalFile
        require(file.isFile && (within(file, staging) || within(file, published)))
        return file
    }

    fun previewUri(path: File, displayName: String): Uri {
        val preview = if (within(path, published)) path else {
            cleanupStale()
            val holders = previews.listFiles().orEmpty()
            require(holders.size < 32)
            val available = maxBytes - holders.sumOf { holder -> holder.listFiles().orEmpty().sumOf(File::length) }
            require(path.length() <= available)
            val folder = directory(previews, UUID.randomUUID().toString())
            val output = File(folder, safeName(displayName))
            try {
                path.inputStream().use { input -> output.outputStream().use { copyBounded(input, it, available) } }
                output
            } catch (t: Throwable) {
                folder.deleteRecursively()
                throw t
            }
        }
        return FileProvider.getUriForFile(context, "${context.packageName}.aerift-files", preview, safeName(displayName))
    }

    fun export(path: File, uri: Uri) {
        require(uri.scheme == ContentResolver.SCHEME_CONTENT)
        path.inputStream().use { input ->
            (resolver.openOutputStream(uri, "wt") ?: error("Document unavailable")).use { output ->
                copyBounded(input, output, path.length())
            }
        }
    }

    fun mime(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
            ?: "application/octet-stream"

    private fun asset(id: String): File = File(durable, UUID.fromString(id).toString())

    private fun readRecord(parent: File): JSONObject? = runCatching {
        require(parent.parentFile == durable && UUID.fromString(parent.name).toString() == parent.name)
        val info = File(parent, "info.json")
        val data = File(parent, "data")
        require(info.isFile && info.length() in 1..4096 && data.isFile)
        JSONObject(info.readText()).also {
            require(it.getString("id") == parent.name && it.getLong("sizeBytes") == data.length())
            require(it.getString("name") == safeName(it.getString("name")))
        }
    }.getOrNull()

    private fun within(file: File, root: File): Boolean = file.path.startsWith(root.canonicalPath + File.separator)

    private fun directory(parent: File, name: String): File = File(parent, name).also {
        check(it.isDirectory || it.mkdirs())
    }

    private fun copyBounded(input: InputStream, output: OutputStream, max: Long): Long {
        require(max >= 0)
        var count = 0L
        val buffer = ByteArray(64 * 1024)
        while (true) {
            check(!Thread.currentThread().isInterrupted)
            val read = input.read(buffer)
            if (read < 0) break
            check(read > 0)
            count += read
            require(count <= max)
            output.write(buffer, 0, read)
        }
        return count
    }

    fun safeName(raw: String): String {
        val name = raw.take(512).map { if (it.isISOControl() || it in "/\\:*?\"<>|") '_' else it }.joinToString("")
            .trim().trim('.')
        if (name.isBlank()) return "Attachment"
        val suffix = name.substringAfterLast('.', "").takeIf { it.matches(Regex("[A-Za-z0-9]{1,12}")) }
        val extension = suffix?.let { ".$it" }.orEmpty()
        val stem = if (extension.isEmpty()) name else name.removeSuffix(extension)
        val safe = StringBuilder()
        var offset = 0
        var budget = 176 - extension.toByteArray(Charsets.UTF_8).size
        while (offset < stem.length) {
            val point = stem.codePointAt(offset)
            val glyph = String(Character.toChars(point))
            val size = glyph.toByteArray(Charsets.UTF_8).size
            if (size > budget) break
            safe.append(glyph)
            budget -= size
            offset += Character.charCount(point)
        }
        return safe.toString().trimEnd().trimEnd('.').ifBlank { "Attachment" } + extension
    }
}
