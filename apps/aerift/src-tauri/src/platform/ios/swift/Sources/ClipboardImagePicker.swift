import UIKit
import UniformTypeIdentifiers

enum ClipboardImageError: Error {
    case noImage
}

@available(iOS 16.0, *)
@MainActor
final class ClipboardImagePicker: UIViewController {
    private var completion: ((Result<StagedSelection?, Error>) -> Void)?
    private var loading: Progress?
    private let pasteButton = UIPasteControl(configuration: .init())
    private let message = UILabel()

    init(completion: @escaping (Result<StagedSelection?, Error>) -> Void) {
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .formSheet
        isModalInPresentation = true
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.image.identifier])
        pasteButton.target = self
        pasteButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true

        message.text = "Paste a copied image to prepare one temporary file for Rift."
        message.font = .preferredFont(forTextStyle: .body)
        message.adjustsFontForContentSizeCategory = true
        message.numberOfLines = 0

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.titleLabel?.font = .preferredFont(forTextStyle: .body)
        cancel.titleLabel?.adjustsFontForContentSizeCategory = true
        cancel.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        cancel.addAction(UIAction { [weak self] _ in
            self?.loading?.cancel()
            self?.finish(.success(nil))
        }, for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [message, pasteButton, cancel])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.addSubview(stack)
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: safe.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: safe.bottomAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -20),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40)
        ])
    }

    override func paste(itemProviders: [NSItemProvider]) {
        guard completion != nil, loading == nil else { return }
        guard let provider = itemProviders.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }),
              let type = provider.registeredTypeIdentifiers.compactMap({ UTType($0) }).first(where: {
                  $0.conforms(to: .image)
              }) else {
            finish(.failure(ClipboardImageError.noImage))
            return
        }
        pasteButton.isUserInteractionEnabled = false
        message.text = "Preparing image…"
        loading = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { [self] url, error in
            // The provider owns this temporary URL and can remove it after this callback.
            let result = Result {
                if let error { throw error }
                guard let url else { throw ClipboardImageError.noImage }
                let fileExtension = !url.pathExtension.isEmpty ? url.pathExtension : type.preferredFilenameExtension
                guard let fileExtension, !fileExtension.isEmpty else { throw ClipboardImageError.noImage }
                return try FileStaging.stage(url, preferredName: "Clipboard image.\(fileExtension)")
            }
            DispatchQueue.main.async {
                if self.completion == nil {
                    if case .success(let staged) = result {
                        try? FileManager.default.removeItem(at: staged.url)
                        try? FileManager.default.removeItem(at: staged.url.deletingLastPathComponent())
                    }
                } else {
                    self.finish(result.map(Optional.some))
                }
            }
        }
    }

    private func finish(_ result: Result<StagedSelection?, Error>) {
        guard let callback = completion else { return }
        completion = nil
        loading = nil
        dismiss(animated: true) { callback(result) }
    }
}
