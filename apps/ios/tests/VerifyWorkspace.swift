import Foundation
import Vision
import Darwin

guard CommandLine.arguments.count == 2 else {
    fputs("Pass an iPhone simulator screenshot.\n", stderr)
    exit(EXIT_FAILURE)
}

let screenshot = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
do {
    try VNImageRequestHandler(url: screenshot, options: [:]).perform([request])
} catch {
    fputs("Could not read the simulator screenshot: \(error)\n", stderr)
    exit(EXIT_FAILURE)
}

let visible = (request.results ?? [])
    .compactMap { $0.topCandidates(1).first?.string.lowercased() }
    .joined(separator: " ")
let visibleWords = Set(visible.split(whereSeparator: { !$0.isLetter }).map(String.init))
// The centered brand is an image rather than OCR text. Each dock label
// must be its own recognized word: "rift" cannot match inside a logo.
let expectedControls = ["home", "workspace", "rift", "devices", "activity"]
let missing = expectedControls.filter { !visibleWords.contains($0) }
if !missing.isEmpty {
    fputs("Missing iPhone workspace controls: \(missing.joined(separator: ", "))\n", stderr)
    exit(EXIT_FAILURE)
}
print("Verified the iPhone Home screen, and floating destinations.")
