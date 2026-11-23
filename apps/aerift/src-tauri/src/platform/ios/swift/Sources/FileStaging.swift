import Foundation

/// Passed to Rust. Only the opaque selection ID, display name and size reach the UI.
struct StagedSelection {
    let url: URL
    let name: String
    let sizeBytes: Int
}

enum StagingError: Error {
    case invalidFile
    case limitExceeded
    case insufficientSpace
}

enum FileStaging {
    static let limitBytes = 512 * 1_024 * 1_024
    private static let freeSpaceMargin = 64 * 1_024 * 1_024

    // A killed app cannot run the Rust selection's destructor.
    private static let stagingDirectory = Result<URL, Error> {
        let manager = FileManager.default
        let cache = try manager.url(for: .cachesDirectory, in: .userDomainMask,
                                    appropriateFor: nil, create: true)
        let root = cache.appendingPathComponent("AeRift-Imports", isDirectory: true)
        if manager.fileExists(atPath: root.path) {
            try manager.removeItem(at: root)
        }
        try manager.createDirectory(at: root, withIntermediateDirectories: false)
        return root
    }

    static func stage(_ source: URL, preferredName: String? = nil) throws -> StagedSelection {
        try stage(source, preferredName: preferredName, in: stagingDirectory.get())
    }

    static func stage(_ source: URL, preferredName: String? = nil, in root: URL) throws -> StagedSelection {
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size >= 0 else {
            throw StagingError.invalidFile
        }
        guard size <= limitBytes else { throw StagingError.limitExceeded }

        let manager = FileManager.default
        let selections = try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        var remainingBudget = limitBytes
        for selection in selections {
            let file = selection.appendingPathComponent("content")
            // Native owners can delete earlier selections while a new item is being imported.
            if let bytes = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                remainingBudget -= min(remainingBudget, bytes)
            } else if manager.fileExists(atPath: file.path) {
                throw StagingError.invalidFile
            }
        }
        guard size <= remainingBudget else { throw StagingError.limitExceeded }

        let capacity = try root.resourceValues(forKeys: [.volumeAvailableCapacityKey]).volumeAvailableCapacity
        guard let capacity, capacity >= size + freeSpaceMargin else {
            throw StagingError.insufficientSpace
        }

        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false)
        let destination = directory.appendingPathComponent("content")
        do {
            try copyExactly(size, from: source, to: destination)
            let name = preferredName.map { ($0 as NSString).lastPathComponent } ?? source.lastPathComponent
            let displayName = (name as NSString).pathExtension.isEmpty && !source.pathExtension.isEmpty
                ? "\(name).\(source.pathExtension)" : name
            return StagedSelection(url: destination, name: displayName, sizeBytes: size)
        } catch {
            try? manager.removeItem(at: directory)
            throw error
        }
    }

    private static func copyExactly(_ size: Int, from source: URL, to destination: URL) throws {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
            throw StagingError.insufficientSpace
        }
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }

        var remaining = size
        while remaining > 0 {
            guard let chunk = try input.read(upToCount: min(remaining, 1_024 * 1_024)),
                  !chunk.isEmpty else {
                throw StagingError.invalidFile
            }
            try output.write(contentsOf: chunk)
            remaining -= chunk.count
        }
        if let trailing = try input.read(upToCount: 1), !trailing.isEmpty {
            throw StagingError.invalidFile
        }
        try output.synchronize()
    }
}
