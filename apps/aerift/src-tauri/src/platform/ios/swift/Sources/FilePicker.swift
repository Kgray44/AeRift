import Foundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers

enum FilePickerError: Error {
    case unavailable
    case alreadyPresenting
    case badRepresentation
    case tooManyItems
}

enum PickerSource: String, Decodable {
    case files
    case photos
}

@MainActor
final class FilePicker: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate {
    static let maximumBatch = 12
    private var limit = 1
    private var completion: ((Result<[StagedSelection], Error>) -> Void)?

    func present(
        from presenter: UIViewController,
        source: PickerSource?,
        limit: Int,
        completion: @escaping (Result<[StagedSelection], Error>) -> Void
    ) {
        guard self.completion == nil else {
            completion(.failure(FilePickerError.alreadyPresenting))
            return
        }
        guard presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else {
            completion(.failure(FilePickerError.unavailable))
            return
        }

        guard (1...Self.maximumBatch).contains(limit) else {
            completion(.failure(FilePickerError.tooManyItems))
            return
        }
        self.limit = limit
        self.completion = completion
        if let source {
            open(source, from: presenter)
            return
        }
        let sources = SourcePickerController { [weak self, weak presenter] source in
            guard let self else { return }
            guard let source else {
                self.finish(.success([]))
                return
            }
            guard let presenter, presenter.viewIfLoaded?.window != nil else {
                self.finish(.failure(FilePickerError.unavailable))
                return
            }
            self.open(source, from: presenter)
        }
        sources.modalPresentationStyle = .formSheet
        sources.isModalInPresentation = true
        presenter.present(sources, animated: true)
    }

    private func open(_ source: PickerSource, from presenter: UIViewController) {
        switch source {
        case .files:
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: false)
            picker.allowsMultipleSelection = limit > 1
            picker.delegate = self
            picker.isModalInPresentation = true
            presenter.present(picker, animated: true)
        case .photos:
            var configuration = PHPickerConfiguration()
            configuration.filter = .any(of: [.images, .videos])
            configuration.selectionLimit = limit
            if limit > 1 { configuration.selection = .ordered }
            configuration.preferredAssetRepresentationMode = .current
            let picker = PHPickerViewController(configuration: configuration)
            picker.delegate = self
            picker.isModalInPresentation = true
            presenter.present(picker, animated: true)
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(.success([]))
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard urls.count <= limit else {
            finish(.failure(FilePickerError.tooManyItems))
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result {
                try FileStaging.stageBatch(urls) { url in
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    var coordinationError: NSError?
                    var result: Result<StagedSelection, Error> = .failure(FilePickerError.unavailable)
                    NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { file in
                        result = Result { try FileStaging.stage(file) }
                    }
                    if let coordinationError {
                        if case .success(let item) = result { FileStaging.discard([item]) }
                        throw coordinationError
                    }
                    return try result.get()
                }
            }
            DispatchQueue.main.async { self.finish(result) }
        }
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true) {
            guard results.count <= self.limit else {
                self.finish(.failure(FilePickerError.tooManyItems))
                return
            }
            self.loadPhotos(results[...], staged: [])
        }
    }

    private func loadPhotos(_ remaining: ArraySlice<PHPickerResult>, staged: [StagedSelection]) {
        guard let next = remaining.first else {
            finish(.success(staged))
            return
        }
        let provider = next.itemProvider
        guard let type = provider.registeredTypeIdentifiers.compactMap({ UTType($0) }).first(where: {
            $0.conforms(to: .image) || $0.conforms(to: .movie)
        }) else {
            FileStaging.discard(staged)
            finish(.failure(FilePickerError.badRepresentation))
            return
        }
        let kind: StagedKind = type.conforms(to: .movie) ? .video : .photo
        provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
            // The system owns this URL and may remove it after this callback.
            let result = Result {
                if let error { throw error }
                guard let url else { throw FilePickerError.badRepresentation }
                var item = try FileStaging.stage(url, preferredName: provider.suggestedName)
                item.kind = kind
                return item
            }
            DispatchQueue.main.async {
                switch result {
                case .success(let item):
                    self.loadPhotos(remaining.dropFirst(), staged: staged + [item])
                case .failure(let error):
                    FileStaging.discard(staged)
                    self.finish(.failure(error))
                }
            }
        }
    }

    private func finish(_ result: Result<[StagedSelection], Error>) {
        let callback = completion
        completion = nil
        callback?(result)
    }

}

@MainActor
private final class SourcePickerController: UIViewController {
    private let choose: (PickerSource?) -> Void

    init(choose: @escaping (PickerSource?) -> Void) {
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

    private func button(_ title: String, source: PickerSource?) -> UIButton {
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
