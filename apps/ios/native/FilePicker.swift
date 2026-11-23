import Foundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Passed to native code. The bridge must retain the path and issue an opaque
/// selection ID before returning the display name and size to the webview.
struct StagedSelection {
    let url: URL
    let name: String
    let sizeBytes: Int
}

enum FilePickerError: Error {
    case unavailable
    case alreadyPresenting
    case badRepresentation
    case invalidFile
}

@MainActor
final class FilePicker: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate {
    private var completion: ((Result<StagedSelection?, Error>) -> Void)?

    func present(
        from presenter: UIViewController,
        completion: @escaping (Result<StagedSelection?, Error>) -> Void
    ) {
        guard self.completion == nil else {
            completion(.failure(FilePickerError.alreadyPresenting))
            return
        }
        guard presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else {
            completion(.failure(FilePickerError.unavailable))
            return
        }

        self.completion = completion
        let sources = SourcePickerController { [weak self, weak presenter] source in
            guard let self else { return }
            guard let source else {
                self.finish(.success(nil))
                return
            }
            guard let presenter, presenter.viewIfLoaded?.window != nil else {
                self.finish(.failure(FilePickerError.unavailable))
                return
            }
            switch source {
            case .files:
                let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
                picker.delegate = self
                presenter.present(picker, animated: true)
            case .photos:
                var configuration = PHPickerConfiguration()
                configuration.filter = .any(of: [.images, .videos])
                configuration.selectionLimit = 1
                configuration.preferredAssetRepresentationMode = .current
                let picker = PHPickerViewController(configuration: configuration)
                picker.delegate = self
                presenter.present(picker, animated: true)
            }
        }
        sources.modalPresentationStyle = .formSheet
        sources.isModalInPresentation = true
        presenter.present(sources, animated: true)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(.success(nil))
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else {
            finish(.success(nil))
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let result = Result { try Self.stage(url) as StagedSelection? }
            DispatchQueue.main.async { self.finish(result) }
        }
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider else {
            finish(.success(nil))
            return
        }
        guard let type = provider.registeredTypeIdentifiers.first(where: { identifier in
            guard let type = UTType(identifier) else { return false }
            return type.conforms(to: .image) || type.conforms(to: .movie)
        }) else {
            finish(.failure(FilePickerError.badRepresentation))
            return
        }
        provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
            // The system owns this URL and can remove it when this callback returns.
            let result = Result {
                if let error { throw error }
                guard let url else { throw FilePickerError.badRepresentation }
                return try Self.stage(url, preferredName: provider.suggestedName) as StagedSelection?
            }
            DispatchQueue.main.async { self.finish(result) }
        }
    }

    private func finish(_ result: Result<StagedSelection?, Error>) {
        let callback = completion
        completion = nil
        callback?(result)
    }

    private nonisolated static func stage(_ source: URL, preferredName: String? = nil) throws -> StagedSelection {
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size >= 0, size <= 9_007_199_254_740_991 else {
            throw FilePickerError.invalidFile
        }

        let manager = FileManager.default
        let cache = try manager.url(for: .cachesDirectory, in: .userDomainMask,
                                    appropriateFor: nil, create: true)
        let directory = cache.appendingPathComponent("AeRift-Imports", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent("content", isDirectory: false)
        do {
            try manager.copyItem(at: source, to: destination)
            let copiedSize = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize
            guard copiedSize == size else { throw FilePickerError.invalidFile }
            let name = preferredName.map { ($0 as NSString).lastPathComponent } ?? source.lastPathComponent
            let displayName = (name as NSString).pathExtension.isEmpty && !source.pathExtension.isEmpty
                ? "\(name).\(source.pathExtension)" : name
            return StagedSelection(url: destination, name: displayName, sizeBytes: size)
        } catch {
            try? manager.removeItem(at: directory)
            throw error
        }
    }
}

@MainActor
private final class SourcePickerController: UIViewController {
    enum Source {
        case files
        case photos
    }

    private let choose: (Source?) -> Void

    init(choose: @escaping (Source?) -> Void) {
        self.choose = choose
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let heading = UILabel()
        heading.text = "Choose an item"
        heading.font = .preferredFont(forTextStyle: .title2)
        heading.adjustsFontForContentSizeCategory = true
        heading.numberOfLines = 0
        heading.accessibilityTraits.insert(.header)

        let stack = UIStackView(arrangedSubviews: [
            heading,
            button("Files", source: .files),
            button("Photos", source: .photos),
            button("Cancel", source: nil)
        ])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false

        let scroll = UIScrollView()
        scroll.alwaysBounceVertical = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        view.addSubview(scroll)
        let safe = view.safeAreaLayoutGuide
        let content = scroll.contentLayoutGuide
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: safe.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: safe.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40)
        ])
    }

    private func button(_ title: String, source: Source?) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.titleLabel?.font = .preferredFont(forTextStyle: .body)
        button.titleLabel?.adjustsFontForContentSizeCategory = true
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        button.addAction(UIAction { [weak self] _ in
            guard let self, self.view.isUserInteractionEnabled else { return }
            self.view.isUserInteractionEnabled = false
            self.dismiss(animated: true) { self.choose(source) }
        }, for: .touchUpInside)
        return button
    }
}
