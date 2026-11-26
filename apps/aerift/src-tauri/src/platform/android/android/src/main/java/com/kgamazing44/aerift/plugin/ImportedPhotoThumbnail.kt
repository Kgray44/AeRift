package com.kgamazing44.aerift.plugin

import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.os.Build
import androidx.annotation.RequiresApi
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.channels.SeekableByteChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.OpenOption
import java.nio.file.Path
import java.nio.file.SecureDirectoryStream
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributeView
import java.util.UUID

internal object ImportedPhotoThumbnail {
    fun make(durable: java.io.File, assetId: String): ByteArray {
        require(Build.VERSION.SDK_INT >= 28) { "Thumbnail unavailable" }
        return ThumbnailApi28.make(durable.toPath(), assetId)
    }
}

@RequiresApi(28)
private object ThumbnailApi28 {
    private const val inputLimit = 16 * 1024 * 1024
    private const val outputLimit = 128 * 1024
    private const val edge = 256
    private val readOnly = setOf<OpenOption>(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)

    fun make(root: Path, assetId: String): ByteArray {
        require(assetId.length == 36 && UUID.fromString(assetId).toString() == assetId)
        // Open the app-owned parent, then remain anchored to descriptors.
        // If the platform cannot provide a secure directory stream, fail closed.
        val bytes = Files.newDirectoryStream(root.parent!!).use { parent ->
            val secure = parent as? SecureDirectoryStream<Path> ?: error("Thumbnail unavailable")
            secure.newDirectoryStream(root.fileName, LinkOption.NOFOLLOW_LINKS).use { assets ->
                assets.newDirectoryStream(root.fileSystem.getPath(assetId), LinkOption.NOFOLLOW_LINKS).use { copy ->
                    val info = boundedRead(copy, root.fileSystem.getPath("info.json"), 4096)
                    val record = JSONObject(info.toString(Charsets.UTF_8))
                    require(record.getString("id") == assetId && record.getString("kind") == "photo")
                    val expected = record.getLong("sizeBytes")
                    require(expected in 1L..inputLimit.toLong())
                    boundedRead(copy, root.fileSystem.getPath("data"), inputLimit, expected)
                }
            }
        }
        val jpeg = bytes.size >= 3 && (bytes[0].toInt() and 255) == 0xff &&
            (bytes[1].toInt() and 255) == 0xd8 && (bytes[2].toInt() and 255) == 0xff
        val mark = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        val png = bytes.size >= mark.size && mark.indices.all { bytes[it] == mark[it] }
        require(jpeg || png)
        val source = ImageDecoder.createSource(ByteBuffer.wrap(bytes))
        val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            val w = info.size.width
            val h = info.size.height
            require(!info.isAnimated && ((jpeg && info.mimeType == "image/jpeg") || (png && info.mimeType == "image/png")))
            require(w > 0 && h > 0 && maxOf(w, h) <= 8192 && w <= 24_000_000 / h)
            val divisor = maxOf(w, h, edge)
            decoder.setTargetSize(maxOf(1, w * edge / divisor), maxOf(1, h * edge / divisor))
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        try {
            require(maxOf(bitmap.width, bitmap.height) <= edge)
            val stream = ByteArrayOutputStream()
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, 78, stream))
            require(stream.size() in 1..outputLimit)
            return stream.toByteArray()
        } finally {
            bitmap.recycle()
        }
    }

    private fun boundedRead(directory: SecureDirectoryStream<Path>, leaf: Path, limit: Int, expected: Long? = null): ByteArray {
        val view = directory.getFileAttributeView(leaf, BasicFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)
        require(view.readAttributes().isRegularFile)
        return directory.newByteChannel(leaf, readOnly).use { channel ->
            val size = channel.size()
            require(size in 1L..limit.toLong() && (expected == null || expected == size))
            readExact(channel, size.toInt())
        }
    }

    private fun readExact(channel: SeekableByteChannel, size: Int): ByteArray {
        val result = ByteBuffer.allocate(size)
        while (result.hasRemaining()) check(channel.read(result) > 0)
        check(channel.size() == size.toLong())
        return result.array()
    }
}
