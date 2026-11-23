import Darwin
import Foundation
import UIKit

struct BonjourPeer: Encodable {
    let id: String
    let name: String
    let platform: String
    let endpoints: [Endpoint]

    struct Endpoint: Encodable, Hashable {
        let ip: String
        let port: UInt16
        let scopeId: UInt32

        init?(address: Data, port: UInt16) {
            var storage = sockaddr_storage()
            guard address.count >= MemoryLayout<sockaddr>.size,
                  address.count <= MemoryLayout<sockaddr_storage>.size else { return nil }
            withUnsafeMutableBytes(of: &storage) { $0.copyBytes(from: address) }
            let family = Int32(storage.ss_family)
            guard family == AF_INET || family == AF_INET6 else { return nil }
            let addressSize = family == AF_INET ? MemoryLayout<sockaddr_in>.size : MemoryLayout<sockaddr_in6>.size
            guard address.count >= addressSize, storage.ss_len == UInt8(addressSize) else { return nil }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let hostLength = socklen_t(host.count)
            var scope: UInt32 = 0
            let status = withUnsafePointer(to: &storage) { pointer in
                if family == AF_INET6 {
                    scope = pointer.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee.sin6_scope_id }
                }
                return pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    getnameinfo($0, socklen_t(addressSize), &host, hostLength, nil, 0, NI_NUMERICHOST)
                }
            }
            guard status == 0 else { return nil }
            let numeric = String(cString: host).split(separator: "%", maxSplits: 1)
            guard let ip = numeric.first else { return nil }
            self.ip = String(ip)
            self.port = port
            scopeId = scope
        }
    }
}

struct BonjourUpdate: Encodable {
    let state: String
    let peers: [BonjourPeer]
}

enum BonjourError: Error {
    case busy
    case invalidDevice
}

/// Uses the system DNS-SD service for the fixed v1 service type. The Rust
/// transport owns the TCP listener and treats every discovered identity as untrusted.
@MainActor
final class BonjourDiscovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    private static let type = "_aerift._tcp."
    private static let domain = "local."
    private static let platforms: Set<String> = ["windows", "ios", "android", "macos", "linux"]

    private struct Request {
        let id: String
        let name: String
        let port: UInt16
        let onChange: (BonjourUpdate) -> Void
    }

    private var deferred: Request?
    private var current: Request?
    private var browser: NetServiceBrowser?
    private var publisher: NetService?
    private var published = false
    private var ownId: String?
    private var resolved = [String: BonjourPeer]()
    private var services = [String: NetService]()

    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(didEnterBackground(_:)),
            name: UIApplication.didEnterBackgroundNotification, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(didBecomeActive(_:)),
            name: UIApplication.didBecomeActiveNotification, object: nil
        )
    }

    func start(
        id: String, name: String, port: UInt16, onChange: @escaping (BonjourUpdate) -> Void
    ) throws {
        guard browser == nil, deferred == nil else { throw BonjourError.busy }
        guard Self.validId(id), Self.validName(name), port != 0 else { throw BonjourError.invalidDevice }

        let request = Request(id: id, name: name, port: port, onChange: onChange)
        guard UIApplication.shared.applicationState == .active else {
            deferred = request
            onChange(BonjourUpdate(state: "suspended", peers: []))
            return
        }
        try run(request)
    }

    private func run(_ request: Request) throws {
        let (id, name, port, onChange) = (request.id, request.name, request.port, request.onChange)
        let instance = "aerift-" + String(id.prefix(32))
        let publisher = NetService(domain: Self.domain, type: Self.type, name: instance, port: Int32(port))
        let records = [
            "v": Data("1".utf8),
            "id": Data(id.utf8),
            "name": Data(name.utf8),
            "platform": Data("ios".utf8)
        ]
        guard publisher.setTXTRecord(NetService.data(fromTXTRecord: records)) else {
            throw BonjourError.invalidDevice
        }
        let browser = NetServiceBrowser()
        publisher.delegate = self
        browser.delegate = self

        self.ownId = id
        current = request
        self.publisher = publisher
        self.browser = browser
        onChange(BonjourUpdate(state: "starting", peers: []))
        browser.searchForServices(ofType: Self.type, inDomain: Self.domain)
        publisher.publish(options: .noAutoRename)
    }

    func stop() {
        let waiting = deferred
        deferred = nil
        stop(state: "disabled")
        waiting?.onChange(BonjourUpdate(state: "disabled", peers: []))
    }

    @objc private func didEnterBackground(_ notification: Notification) {
        guard let current else { return }
        deferred = current
        stop(state: "suspended")
    }

    @objc private func didBecomeActive(_ notification: Notification) {
        guard let request = deferred else { return }
        deferred = nil
        do {
            try run(request)
        } catch {
            request.onChange(BonjourUpdate(state: "unavailable", peers: []))
        }
    }

    func netServiceDidPublish(_ sender: NetService) {
        if sender === publisher {
            published = true
            publishSnapshot()
        }
    }

    func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) {
        if sender === publisher { stop(state: "unavailable") }
    }

    func netServiceBrowser(_ sender: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        if sender === browser { stop(state: "unavailable") }
    }

    func netServiceBrowser(_ sender: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        guard sender === browser, services.count < 256 else { return }
        let key = service.name.lowercased()
        guard services[key] == nil else { return }
        services[key] = service
        service.delegate = self
        service.resolve(withTimeout: 5)
    }

    func netServiceBrowser(_ sender: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        guard sender === browser else { return }
        let key = service.name.lowercased()
        if let pending = services.removeValue(forKey: key) {
            pending.delegate = nil
            pending.stop()
        }
        if resolved.removeValue(forKey: key) != nil { publishSnapshot() }
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        let key = sender.name.lowercased()
        guard services[key] === sender, let data = sender.txtRecordData(),
              let port = UInt16(exactly: sender.port), port != 0 else { return }
        let txt = NetService.dictionary(fromTXTRecord: data).compactMapValues {
            String(data: $0, encoding: .utf8)
        }
        guard txt["v"] == "1", let id = txt["id"], Self.validId(id), id != ownId,
              let name = txt["name"], Self.validName(name), let platform = txt["platform"],
              Self.platforms.contains(platform) else { return }
        let endpoints = (sender.addresses ?? []).prefix(16).compactMap { BonjourPeer.Endpoint(address: $0, port: port) }
        guard !endpoints.isEmpty else { return }

        resolved[key] = BonjourPeer(id: id, name: name, platform: platform, endpoints: endpoints)
        publishSnapshot()
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        let key = sender.name.lowercased()
        if services[key] === sender { services.removeValue(forKey: key) }
    }

    private func publishSnapshot() {
        let grouped = Dictionary(grouping: resolved.sorted { $0.key < $1.key }.map(\.value), by: \.id)
        let peers = grouped.keys.sorted().compactMap { id -> BonjourPeer? in
            guard let instances = grouped[id], let first = instances.first else { return nil }
            var seen = Set<BonjourPeer.Endpoint>()
            let endpoints = instances.flatMap(\.endpoints).filter { seen.insert($0).inserted }.prefix(16)
            return BonjourPeer(id: id, name: first.name, platform: first.platform, endpoints: Array(endpoints))
        }
        current?.onChange(BonjourUpdate(state: published ? "ready" : "starting", peers: peers))
    }

    private func stop(state: String) {
        let callback = current?.onChange
        current = nil
        browser?.delegate = nil
        browser?.stop()
        browser = nil
        publisher?.delegate = nil
        publisher?.stop()
        publisher = nil
        published = false
        for service in services.values {
            service.delegate = nil
            service.stop()
        }
        services.removeAll()
        resolved.removeAll()
        ownId = nil
        callback?(BonjourUpdate(state: state, peers: []))
    }

    private static func validId(_ id: String) -> Bool {
        id.utf8.count == 64 && id.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private static func validName(_ name: String) -> Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.utf8.count <= 120 &&
            !name.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }
}
