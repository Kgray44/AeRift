import Foundation

struct MediaImport: Codable, Equatable {
    let id: UUID
    let name: String
    let kind: StagedKind
    let sizeBytes: Int
}

enum MediaLibraryError: Error {
    case full
    case invalidCatalog
    case missingAsset
}

/// Owns imported copies. Provider originals and live Rift selections use separate URLs.
final class MediaLibrary {
    static let maxItems = 24
    static let maxBatch = 12
    static let limitBytes = 512 * 1_024 * 1_024
    private static let catalogLimit = 128 * 1_024

    private struct Record: Codable {
        let media: MediaImport
        let filename: String
    }

    private struct Catalog: Codable {
        let schemaVersion: Int
        let records: [Record]
    }

    private let root: URL
    private let manager = FileManager.default
    private var records: [Record] = []
    private var catalogURL: URL { root.appendingPathComponent("catalog.json") }

    static func openDeviceLibrary() throws -> MediaLibrary {
        let appSupport = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )
        var root = appSupport.appendingPathComponent("AeRift-Media-Library", isDirectory: true)
        let library = try MediaLibrary(root: root)
        #if os(iOS)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try root.setResourceValues(values)
        #endif
        return library
    }

    init(root: URL) throws {
        self.root = root
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        guard Self.isOwnedDirectory(root) else { throw MediaLibraryError.invalidCatalog }
        let children = try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        if manager.fileExists(atPath: catalogURL.path) {
            let values = try catalogURL.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, size <= Self.catalogLimit else {
                throw MediaLibraryError.invalidCatalog
            }
            let catalog = try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: catalogURL))
            guard catalog.schemaVersion == 1, Self.valid(catalog.records) else {
                throw MediaLibraryError.invalidCatalog
            }
            records = catalog.records
        } else {
            // A missing catalog with existing media must not discard the user's copies.
            guard !children.contains(where: { UUID(uuidString: $0.lastPathComponent) != nil }) else {
                throw MediaLibraryError.invalidCatalog
            }
            try save([])
        }

        // A stopped process may have moved files just before publishing the new catalog,
        // or removed a catalog entry just before unlinking its library copy.
        let ids = Set(records.map { $0.media.id })
        for child in children {
            if let id = UUID(uuidString: child.lastPathComponent),
               child.lastPathComponent == id.uuidString, !ids.contains(id), Self.isOwnedDirectory(child) {
                try? manager.removeItem(at: child)
            }
        }
    }

    func pickerLimit() throws -> Int {
        let remaining = Self.maxItems - records.count
        guard remaining > 0 else { throw MediaLibraryError.full }
        return min(Self.maxBatch, remaining)
    }

    func list() -> [MediaImport] { records.map(\.media) }

    func append(_ files: [StagedSelection]) throws -> [MediaImport] {
        defer { FileStaging.discard(files) }
        guard !files.isEmpty else { return list() }
        guard files.count <= Self.maxBatch, files.count <= Self.maxItems - records.count else {
            throw MediaLibraryError.full
        }
        let added = files.map { file in
            Record(media: MediaImport(id: UUID(), name: file.name, kind: file.kind, sizeBytes: file.sizeBytes),
                   filename: file.url.lastPathComponent)
        }
        let next = records + added
        guard Self.valid(next) else { throw MediaLibraryError.full }
        var created = [URL]()
        do {
            for (file, record) in zip(files, added) {
                let directory = assetDirectory(record.media.id)
                try manager.createDirectory(at: directory, withIntermediateDirectories: false)
                created.append(directory)
                let destination = directory.appendingPathComponent(record.filename)
                try manager.moveItem(at: file.url, to: destination)
                try manager.setAttributes([.posixPermissions: 0o400], ofItemAtPath: destination.path)
            }
            try save(next)
        } catch {
            for directory in created { try? manager.removeItem(at: directory) }
            throw error
        }
        records = next
        return list()
    }

    func remove(_ id: UUID) throws -> [MediaImport] {
        let next = records.filter { $0.media.id != id }
        guard next.count != records.count else { return list() }
        try save(next)
        records = next
        let directory = assetDirectory(id)
        if Self.isOwnedDirectory(directory) { try? manager.removeItem(at: directory) }
        return list()
    }

    struct ThumbnailSource: Equatable, Sendable {
        let root: URL
        let asset: UUID
        let filename: String
        let expectedSize: Int

        func decode() throws -> Data {
            try ImportedPhotoThumbnail.make(root: root, asset: asset, filename: filename, expectedSize: expectedSize)
        }
    }

    // Snapshot this descriptor on the main catalog lane; decoding never reads
    // mutable catalog state or any external photo library.
    func thumbnailSource(_ id: UUID) throws -> ThumbnailSource {
        guard let record = records.first(where: { $0.media.id == id }), record.media.kind == .photo else {
            throw MediaLibraryError.missingAsset
        }
        return ThumbnailSource(root: root, asset: id, filename: record.filename, expectedSize: record.media.sizeBytes)
    }

    func stage(_ id: UUID, in staging: URL? = nil) throws -> StagedSelection {
        guard let record = records.first(where: { $0.media.id == id }) else {
            throw MediaLibraryError.missingAsset
        }
        let directory = assetDirectory(id)
        guard Self.isOwnedDirectory(directory) else { throw MediaLibraryError.missingAsset }
        let source = directory.appendingPathComponent(record.filename)
        if let staging {
            return try FileStaging.stageLibraryLink(source, name: record.media.name,
                                                    size: record.media.sizeBytes, kind: record.media.kind, in: staging)
        }
        return try FileStaging.stageLibraryLink(source, name: record.media.name,
                                                size: record.media.sizeBytes, kind: record.media.kind)
    }

    private func assetDirectory(_ id: UUID) -> URL {
        root.appendingPathComponent(id.uuidString, isDirectory: true)
    }

    private func save(_ records: [Record]) throws {
        let bytes = try JSONEncoder().encode(Catalog(schemaVersion: 1, records: records))
        guard bytes.count <= Self.catalogLimit else { throw MediaLibraryError.invalidCatalog }
        try bytes.write(to: catalogURL, options: .atomic)
    }

    private static func isOwnedDirectory(_ url: URL) -> Bool {
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        return values?.isDirectory == true && values?.isSymbolicLink != true
    }

    private static func valid(_ records: [Record]) -> Bool {
        guard records.count <= maxItems, Set(records.map { $0.media.id }).count == records.count else {
            return false
        }
        var remaining = limitBytes
        for record in records {
            let filename = record.filename
            guard !filename.isEmpty, filename != ".", filename != "..", !filename.contains("/"),
                  !record.media.name.isEmpty, record.media.name.utf8.count <= 2_048,
                  record.media.sizeBytes >= 0, record.media.sizeBytes <= remaining else {
                return false
            }
            remaining -= record.media.sizeBytes
        }
        return true
    }
}
