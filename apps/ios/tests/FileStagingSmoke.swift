import Foundation

enum SmokeError: Error {
    case invalidCopy
    case acceptedInvalidSource
    case acceptedOverBudget
    case residualSelection
}

@main
struct FileStagingSmoke {
    static func main() throws {
        let manager = FileManager.default
        let fixture = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let imports = fixture.appendingPathComponent("imports")
        try manager.createDirectory(at: imports, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: fixture) }

        let source = fixture.appendingPathComponent("sample.dat")
        let contents = Data([0, 255, 9, 127])
        try contents.write(to: source)
        let selected = try FileStaging.stage(source, preferredName: "asset", in: imports)
        let stagedBytes = try Data(contentsOf: selected.url)
        guard stagedBytes == contents, selected.name == "asset.dat",
              selected.sizeBytes == contents.count else {
            throw SmokeError.invalidCopy
        }

        let empty = fixture.appendingPathComponent("empty")
        try Data().write(to: empty)
        let emptySelection = try FileStaging.stage(empty, in: imports)
        guard emptySelection.sizeBytes == 0 else { throw SmokeError.invalidCopy }

        let alias = fixture.appendingPathComponent("alias")
        try manager.createSymbolicLink(at: alias, withDestinationURL: source)
        do {
            _ = try FileStaging.stage(alias, in: imports)
            throw SmokeError.acceptedInvalidSource
        } catch StagingError.invalidFile {}

        let heldOutput = try FileHandle(forWritingTo: selected.url)
        try heldOutput.truncate(atOffset: UInt64(FileStaging.limitBytes))
        try heldOutput.close()
        do {
            _ = try FileStaging.stage(source, in: imports)
            throw SmokeError.acceptedOverBudget
        } catch StagingError.limitExceeded {}

        let left = try manager.contentsOfDirectory(atPath: imports.path)
        guard left.count == 2 else { throw SmokeError.residualSelection }
        print("File staging preserved bytes, handled empty input, and rejected unsafe or over-budget imports")
    }
}
