import Foundation

enum MediaSmokeError: Error {
    case invalidRoundTrip
    case invalidRollback
    case removedLiveLink
    case acceptedInvalidCatalog
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
        print("Media library retained IDs and bytes across restart, rolled back a failed batch and kept active links readable")
    }
}
