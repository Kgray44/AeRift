import Foundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers

enum FilePickerError: Error {
    case unavailable
    case alreadyPresenting
    case badRepresentation
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
                let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: false)
                picker.delegate = self
                picker.isModalInPresentation = true
                presenter.present(picker, animated: true)
            case .photos:
                var configuration = PHPickerConfiguration()
                configuration.filter = .any(of: [.images, .videos])
                configuration.selectionLimit = 1
                configuration.preferredAssetRepresentationMode = .current
                let picker = PHPickerViewController(configuration: configuration)
                picker.delegate = self
                picker.isModalInPresentation = true
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
            var coordinationError: NSError?
            var result: Result<StagedSelection?, Error> = .failure(FilePickerError.unavailable)
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { file in
                result = Result { try FileStaging.stage(file) as StagedSelection? }
            }
            let coordinatedResult = coordinationError.map { Result<StagedSelection?, Error>.failure($0) } ?? result
            DispatchQueue.main.async { self.finish(coordinatedResult) }
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
                return try FileStaging.stage(url, preferredName: provider.suggestedName) as StagedSelection?
            }
            DispatchQueue.main.async { self.finish(result) }
        }
    }

    private func finish(_ result: Result<StagedSelection?, Error>) {
        let callback = completion
        completion = nil
        callback?(result)
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
