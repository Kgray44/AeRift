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
        guard stagedBytes == contents, selected.name == "asset.dat", selected.url.lastPathComponent == "asset.dat",
              selected.sizeBytes == contents.count else {
            throw SmokeError.invalidCopy
        }

        let empty = fixture.appendingPathComponent("empty")
        try Data().write(to: empty)
        let emptySelection = try FileStaging.stage(empty, in: imports)
        guard emptySelection.sizeBytes == 0 else { throw SmokeError.invalidCopy }

        let note = "A note with Unicode: \u{00E9}"
        let stagedNote = try FileStaging.stageText(note, name: "Note.md", in: imports)
        let noteBytes = try Data(contentsOf: stagedNote.url)
        guard noteBytes == Data(note.utf8), stagedNote.name == "Note.md",
              stagedNote.sizeBytes == note.utf8.count else {
            throw SmokeError.invalidCopy
        }
        for invalidName in ["../Note.md", "nested\\Note.md", "Note.exe"] {
            do {
                _ = try FileStaging.stageText(note, name: invalidName, in: imports)
                throw SmokeError.acceptedInvalidSource
            } catch StagingError.invalidFile {}
        }
        do {
            _ = try FileStaging.stageText(String(repeating: "x", count: FileStaging.textLimitBytes + 1),
                                          name: "Note.txt", in: imports)
            throw SmokeError.acceptedOverBudget
        } catch StagingError.invalidFile {}

        let alias = fixture.appendingPathComponent("alias")
        try manager.createSymbolicLink(at: alias, withDestinationURL: source)
        do {
            _ = try FileStaging.stage(alias, in: imports)
            throw SmokeError.acceptedInvalidSource
        } catch StagingError.invalidFile {}

        let batchInputs = [source, empty]
        let batch = try FileStaging.stageBatch(batchInputs) {
            try FileStaging.stage($0, in: imports)
        }
        guard batch.map({ $0.name }) == batchInputs.map({ $0.lastPathComponent }),
              try Data(contentsOf: batch[0].url) == contents,
              try Data(contentsOf: batch[1].url).isEmpty else {
            throw SmokeError.invalidCopy
        }
        FileStaging.discard(batch)
        do {
            _ = try FileStaging.stageBatch([source, alias]) {
                try FileStaging.stage($0, in: imports)
            }
            throw SmokeError.acceptedInvalidSource
        } catch StagingError.invalidFile {}
        guard try manager.contentsOfDirectory(atPath: imports.path).count == 3 else {
            throw SmokeError.residualSelection
        }

        let heldOutput = try FileHandle(forWritingTo: selected.url)
        try heldOutput.truncate(atOffset: UInt64(FileStaging.limitBytes))
        try heldOutput.close()
        do {
            _ = try FileStaging.stage(source, in: imports)
            throw SmokeError.acceptedOverBudget
        } catch StagingError.limitExceeded {}

        let left = try manager.contentsOfDirectory(atPath: imports.path)
        guard left.count == 3 else { throw SmokeError.residualSelection }
        print("File and text staging preserved bytes and rejected unsafe or over-budget input")
    }
}
