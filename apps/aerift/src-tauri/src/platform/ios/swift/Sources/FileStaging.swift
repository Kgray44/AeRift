import Foundation

/// Passed to Rust. Only the opaque selection ID, display name and size reach the UI.
enum StagedKind: String, Codable {
    case file, photo, video
}

struct StagedSelection {
    let url: URL
    let name: String
    let sizeBytes: Int
    var kind: StagedKind = .file
}

enum StagingError: Error {
    case invalidFile
    case limitExceeded
    case insufficientSpace
}

enum FileStaging {
    static func discard(_ selections: [StagedSelection]) {
        for selection in selections {
            try? FileManager.default.removeItem(at: selection.url)
            try? FileManager.default.removeItem(at: selection.url.deletingLastPathComponent())
        }
    }

    // A batch is published only when every provider has staged successfully.
    static func stageBatch<T>(_ items: [T], stage: (T) throws -> StagedSelection) throws -> [StagedSelection] {
        var staged = [StagedSelection]()
        do {
            for item in items { staged.append(try stage(item)) }
            return staged
        } catch {
            discard(staged)
            throw error
        }
    }

    static let limitBytes = 512 * 1_024 * 1_024
    private static let stagingLock = NSLock()
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
        let name = preferredName.map { ($0 as NSString).lastPathComponent } ?? source.lastPathComponent
        let displayName = (name as NSString).pathExtension.isEmpty && !source.pathExtension.isEmpty
            ? "\(name).\(source.pathExtension)" : name
        return try stageContent(named: displayName, size: size, in: root) { destination in
            try copyExactly(size, from: source, to: destination)
        }
    }

    static func stageLibraryLink(_ source: URL, name: String, size: Int, kind: StagedKind) throws -> StagedSelection {
        try stageLibraryLink(source, name: name, size: size, kind: kind, in: stagingDirectory.get())
    }

    static func stageLibraryLink(_ source: URL, name: String, size: Int, kind: StagedKind,
                                 in root: URL) throws -> StagedSelection {
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, values.fileSize == size else {
            throw StagingError.invalidFile
        }
        var item = try stageContent(named: name, size: size, in: root, allocatesBytes: false) { destination in
            try FileManager.default.linkItem(at: source, to: destination)
        }
        item.kind = kind
        return item
    }

    static let textLimitBytes = 128 * 1_024

    static func stageText(_ text: String, name: String) throws -> StagedSelection {
        try stageText(text, name: name, in: stagingDirectory.get())
    }

    static func stageText(_ text: String, name: String, in root: URL) throws -> StagedSelection {
        let bytes = Data(text.utf8)
        guard !bytes.isEmpty, bytes.count <= textLimitBytes,
              !name.isEmpty, name.utf8.count <= 180, name == (name as NSString).lastPathComponent,
              name.rangeOfCharacter(from: .controlCharacters) == nil,
              !name.contains("\\"), !name.contains(":"),
              ["txt", "md"].contains((name as NSString).pathExtension) else {
            throw StagingError.invalidFile
        }
        return try stageContent(named: name, size: bytes.count, in: root) { destination in
            try bytes.write(to: destination, options: .withoutOverwriting)
        }
    }

    private static func stageContent(named name: String, size: Int, in root: URL,
                                     allocatesBytes: Bool = true, write: (URL) throws -> Void) throws -> StagedSelection {
        stagingLock.lock()
        defer { stagingLock.unlock() }
        guard size <= limitBytes else { throw StagingError.limitExceeded }

        let manager = FileManager.default
        let selections = try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        var remainingBudget = limitBytes
        for selection in selections {
            let files: [URL]
            do {
                files = try manager.contentsOfDirectory(at: selection, includingPropertiesForKeys: [.fileSizeKey])
            } catch {
                if !manager.fileExists(atPath: selection.path) { continue }
                throw error
            }
            for file in files {
                // Native owners can delete earlier selections while a new item is being imported.
                if let bytes = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                    remainingBudget -= min(remainingBudget, bytes)
                } else if manager.fileExists(atPath: file.path) {
                    throw StagingError.invalidFile
                }
            }
        }
        guard size <= remainingBudget else { throw StagingError.limitExceeded }

        let capacity = try root.resourceValues(forKeys: [.volumeAvailableCapacityKey]).volumeAvailableCapacity
        guard let capacity, capacity >= (allocatesBytes ? size : 0) + freeSpaceMargin else {
            throw StagingError.insufficientSpace
        }

        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false)
        let safeName = !name.isEmpty && name != "." && name != ".." && !name.contains("/") && name.utf8.count <= 240 &&
            name == (name as NSString).lastPathComponent &&
            name.rangeOfCharacter(from: .controlCharacters) == nil ? name : "Content"
        let destination = directory.appendingPathComponent(safeName, isDirectory: false)
        do {
            try write(destination)
            return StagedSelection(url: destination, name: name, sizeBytes: size)
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
