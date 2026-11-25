import Darwin
import Foundation
import ImageIO

/// App-private file component inputs only, never an IPC path or provider URL.
enum ImportedPhotoThumbnail {
    static let inputLimit = 16 * 1024 * 1024
    static let outputLimit = 128 * 1024
    static let maxEdge = 256

    enum Failure: Error { case unavailable, unsupported }

    static func make(root: URL, asset: UUID, filename: String, expectedSize: Int) throws -> Data {
        guard expectedSize > 0, expectedSize <= inputLimit,
              !filename.isEmpty, filename != ".", filename != "..",
              !filename.contains("/"), !filename.contains("\0") else { throw Failure.unavailable }

        let rootFd = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard rootFd >= 0 else { throw Failure.unavailable }
        defer { _ = Darwin.close(rootFd) }
        let assetFd = Darwin.openat(rootFd, asset.uuidString, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard assetFd >= 0 else { throw Failure.unavailable }
        defer { _ = Darwin.close(assetFd) }
        let fd = Darwin.openat(assetFd, filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.unavailable }
        defer { _ = Darwin.close(fd) }

        var before = stat()
        guard fstat(fd, &before) == 0, (before.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              before.st_size == off_t(expectedSize) else { throw Failure.unavailable }

        var bytes = Data()
        bytes.reserveCapacity(expectedSize)
        var chunk = [UInt8](repeating: 0, count: min(64 * 1024, expectedSize))
        while bytes.count < expectedSize {
            let request = min(chunk.count, expectedSize - bytes.count)
            let n = chunk.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, request) }
            guard n > 0 else { throw Failure.unavailable }
            bytes.append(contentsOf: chunk.prefix(n))
        }
        var after = stat()
        guard fstat(fd, &after) == 0, after.st_size == before.st_size,
              after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec,
              after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec else { throw Failure.unavailable }

        let jpeg = bytes.starts(with: [0xff, 0xd8, 0xff])
        let png = bytes.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        let uncached = [kCGImageSourceShouldCache: false] as CFDictionary
        guard jpeg || png, let source = CGImageSourceCreateWithData(bytes as CFData, uncached),
              CGImageSourceGetCount(source) == 1,
              let kind = CGImageSourceGetType(source) as String?,
              (jpeg && kind == "public.jpeg") || (png && kind == "public.png"),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, uncached) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int,
              let h = props[kCGImagePropertyPixelHeight] as? Int,
              w > 0, h > 0, max(w, h) <= 8192, w <= 24_000_000 / h else { throw Failure.unsupported }

        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options),
              image.width > 0, image.height > 0, max(image.width, image.height) <= maxEdge
        else { throw Failure.unsupported }

        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output as CFMutableData, "public.jpeg" as CFString, 1, nil)
        else { throw Failure.unavailable }
        // Re-encode pixels without copying original metadata.
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.78] as CFDictionary)
        guard CGImageDestinationFinalize(destination), output.length > 0, output.length <= outputLimit
        else { throw Failure.unavailable }
        return output as Data
    }
}
