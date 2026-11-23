import SafariServices
import UIKit

struct BrowserLink: Encodable {
    let url: String
    let title: String?

    static func webURL(_ value: String) -> URL? {
        guard value.utf8.count <= 4096,
              let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil else { return nil }
        return components.url
    }
}

@MainActor
final class BrowserLinkCapture: NSObject, SFSafariViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
    private var links: [BrowserLink] = []
    private var onClose: (([BrowserLink]) -> Void)?

    init(onClose: @escaping ([BrowserLink]) -> Void) {
        self.onClose = onClose
    }

    func safariViewController(
        _ controller: SFSafariViewController,
        activityItemsFor url: URL,
        title: String?
    ) -> [UIActivity] {
        guard links.count < 20, let webURL = BrowserLink.webURL(url.absoluteString) else { return [] }
        let address = webURL.absoluteString
        let name = title.map { String($0.prefix(100)) }
        return [CollectBrowserLink { [weak self] in
            guard let self, self.onClose != nil else { return false }
            if self.links.contains(where: { $0.url == address }) { return true }
            guard self.links.count < 20 else { return false }
            self.links.append(.init(url: address, title: name))
            return true
        }]
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) { finish() }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish() }

    private func finish() {
        let callback = onClose
        onClose = nil
        callback?(links)
    }
}

@MainActor
private final class CollectBrowserLink: UIActivity {
    private let collect: () -> Bool

    init(collect: @escaping () -> Bool) {
        self.collect = collect
        super.init()
    }

    override class var activityCategory: UIActivity.Category { .action }
    override var activityType: UIActivity.ActivityType? { .init("com.kgamazing44.aerift.collect-link") }
    override var activityTitle: String? { "Collect in AeRift" }
    override var activityImage: UIImage? { UIImage(systemName: "link") }
    override func canPerform(withActivityItems activityItems: [Any]) -> Bool { true }
    override func prepare(withActivityItems activityItems: [Any]) {}
    override func perform() { activityDidFinish(collect()) }
}
