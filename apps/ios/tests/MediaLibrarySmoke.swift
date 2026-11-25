import CoreGraphics
import Foundation
import ImageIO

enum MediaSmokeError: Error {
    case invalidRoundTrip
    case invalidRollback
    case removedLiveLink
    case acceptedInvalidCatalog
    case invalidThumbnail
}

@main
struct MediaLibrarySmoke {
    static func main() throws {
        let manager = FileManager.default
        let fixture = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let catalog = fixture.appendingPathComponent("library", isDirectory: true)
        let staging = fixture.appendingPathComponent("staging", isDirectory: true)
        try manager.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: fixture) }

        let source = fixture.appendingPathComponent("source.bin")
        let data = Data([0, 17, 255, 8])
        try data.write(to: source)
        let store = try MediaLibrary(root: catalog)
        let staged = try FileStaging.stage(source, in: staging)
        let imported = try store.append([staged])
        guard imported.count == 1, imported[0].name == "source.bin",
              imported[0].sizeBytes == data.count, try Data(contentsOf: source) == data else {
            throw MediaSmokeError.invalidRoundTrip
        }
        let id = imported[0].id
        let restarted = try MediaLibrary(root: catalog)
        guard restarted.list() == imported else { throw MediaSmokeError.invalidRoundTrip }
        let link = try restarted.stage(id, in: staging)
        guard try Data(contentsOf: link.url) == data else { throw MediaSmokeError.invalidRoundTrip }

        let good = try FileStaging.stage(source, in: staging)
        let missing = try FileStaging.stage(source, in: staging)
        try manager.removeItem(at: missing.url)
        do {
            _ = try restarted.append([good, missing])
            throw MediaSmokeError.invalidRollback
        } catch MediaSmokeError.invalidRollback {
            throw MediaSmokeError.invalidRollback
        } catch {}
        let afterFailure = try MediaLibrary(root: catalog)
        let directories = try manager.contentsOfDirectory(atPath: catalog.path).filter { UUID(uuidString: $0) != nil }
        guard afterFailure.list() == imported, directories == [id.uuidString],
              try Data(contentsOf: source) == data else {
            throw MediaSmokeError.invalidRollback
        }

        guard try restarted.remove(id).isEmpty,
              try Data(contentsOf: link.url) == data else { throw MediaSmokeError.removedLiveLink }
        FileStaging.discard([link])
        guard try MediaLibrary(root: catalog).list().isEmpty else { throw MediaSmokeError.invalidRoundTrip }

        let last = try FileStaging.stage(source, in: staging)
        let lastImport = try restarted.append([last])
        let catalogURL = catalog.appendingPathComponent("catalog.json")
        try Data("unreadable".utf8).write(to: catalogURL, options: .atomic)
        do {
            _ = try MediaLibrary(root: catalog)
            throw MediaSmokeError.acceptedInvalidCatalog
        } catch MediaSmokeError.acceptedInvalidCatalog {
            throw MediaSmokeError.acceptedInvalidCatalog
        } catch {}
        let lastFile = catalog.appendingPathComponent(lastImport[0].id.uuidString)
            .appendingPathComponent("source.bin")
        guard try Data(contentsOf: lastFile) == data else { throw MediaSmokeError.invalidRoundTrip }
        try checkThumbnails(fixture: fixture, staging: staging, manager: manager)
        print("Media library retained IDs and bytes across restart, rolled back a failed batch and kept active links readable")
    }

    static func checkThumbnails(fixture: URL, staging: URL, manager: FileManager) throws {
        let root = fixture.appendingPathComponent("photo-library", isDirectory: true)
        let store = try MediaLibrary(root: root)
        let photo = fixture.appendingPathComponent("synthetic-photo.jpg")
        guard let context = CGContext(data: nil, width: 512, height: 300, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
              let destination = CGImageDestinationCreateWithURL(photo as CFURL, "public.jpeg" as CFString, 1, nil)
        else { throw MediaSmokeError.invalidThumbnail }
        context.setFillColor(red: 0.23, green: 0.5, blue: 0.8, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 512, height: 300))
        guard let image = context.makeImage() else { throw MediaSmokeError.invalidThumbnail }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw MediaSmokeError.invalidThumbnail }
        var staged = try FileStaging.stage(photo, in: staging)
        staged.kind = .photo
        guard let id = try store.append([staged]).first?.id else { throw MediaSmokeError.invalidThumbnail }
        let bound = try store.thumbnailSource(id)
        let jpeg = try bound.decode()
        guard jpeg.starts(with: [0xff, 0xd8, 0xff]), jpeg.count <= 128 * 1024,
              let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
              let preview = CGImageSourceCreateImageAtIndex(source, 0, nil),
              preview.width == 256, preview.height > 0, preview.height <= 256
        else { throw MediaSmokeError.invalidThumbnail }
        let owned = bound.root.appendingPathComponent(bound.asset.uuidString).appendingPathComponent(bound.filename)
        try manager.removeItem(at: owned)
        try manager.createSymbolicLink(at: owned, withDestinationURL: photo)
        guard (try? bound.decode()) == nil else { throw MediaSmokeError.invalidThumbnail }
        try manager.removeItem(at: owned)
        try Data(repeating: 0x41, count: bound.expectedSize).write(to: owned)
        guard (try? bound.decode()) == nil else { throw MediaSmokeError.invalidThumbnail }
        _ = try store.remove(id)
        guard (try? store.thumbnailSource(id)) == nil else { throw MediaSmokeError.invalidThumbnail }
        print("Native ImageIO rendered a 256-pixel JPEG and refused a linked, malformed or removed imported copy")
    }
}
