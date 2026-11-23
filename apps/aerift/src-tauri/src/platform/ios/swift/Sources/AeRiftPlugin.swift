import QuickLook
import SafariServices
import AVFoundation
import Tauri
import UIKit

private struct SelectionArgs: Decodable {
    let path: String
    let action: String
}

@MainActor
private final class SelectionPreview: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    let item: NSURL
    let done: () -> Void

    init(url: URL, done: @escaping () -> Void) {
        self.item = url as NSURL
        self.done = done
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        item
    }

    func previewControllerDidDismiss(_ controller: QLPreviewController) {
        done()
    }
}

private struct TextArgs: Decodable {
    let text: String
    let name: String
}

private struct BrowserArgs: Decodable {
    let url: String
}

private struct PickerArgs: Decodable {
    let source: PickerSource?
    let limit: Int
    let persist: Bool
}

private struct MediaLibraryResponse: Encodable {
    let items: [MediaImport]
}

private struct MediaAssetArgs: Decodable {
    let assetId: UUID
}

private struct PickerResponse: Encodable {
    struct Selection: Encodable {
        let path: String
        let name: String
        let sizeBytes: Int
        var kind: StagedKind = .file
    }

    let selection: Selection?
}

private struct ClipboardImageCapability: Encodable {
    let supported: Bool
}

private struct BatchPickerResponse: Encodable {
    let selections: [PickerResponse.Selection]
}

private struct CameraArgs: Decodable {
    let attemptId: String
    let events: Channel
}

private struct CameraStop: Decodable {
    let attemptId: String
}

private struct CameraClock: Encodable {
    let clockMs: Double
}

private struct CameraPermissionRequest: Decodable {
    let request: Bool
}

private struct CameraPermission: Encodable {
    let status: String
}

private struct CameraUpdate: Encodable {
    let type: String
    let attemptId: String
    let frame: HandFrame?
    let state: String?

    static func status(_ state: String, attemptId: String) -> Self {
        Self(type: "state", attemptId: attemptId, frame: nil, state: state)
    }

    static func landmarks(_ frame: HandFrame, attemptId: String) -> Self {
        Self(type: "frame", attemptId: attemptId, frame: frame, state: nil)
    }
}

private struct DiscoveryArgs: Decodable {
    let id: String
    let name: String
    let port: UInt16
    let events: Channel
}

final class AeRiftPlugin: Plugin {
    @MainActor private var selectionPreview: SelectionPreview?
    @MainActor private lazy var filePicker = FilePicker()
    @MainActor private var mediaLibrary: MediaLibrary?

    @MainActor
    private func openMediaLibrary() throws -> MediaLibrary {
        if let mediaLibrary { return mediaLibrary }
        let library = try MediaLibrary.openDeviceLibrary()
        mediaLibrary = library
        return library
    }
    @MainActor private lazy var handCamera = HandCamera()
    @MainActor private var cameraAttempt: CameraArgs?
    @MainActor private var cancelledAttempts: [String] = []
    @MainActor private lazy var discovery = BonjourDiscovery()

    @objc func pickFile(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PickerArgs.self)
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active,
                  let presenter = self.manager.viewController else {
                invoke.reject("Open AeRift to choose an item.")
                return
            }

            let library: MediaLibrary?
            let limit: Int
            do {
                library = args.persist ? try self.openMediaLibrary() : nil
                limit = try library?.pickerLimit() ?? args.limit
            } catch {
                invoke.reject("AeRift could not open the import library or it is full.")
                return
            }
            if let attempt = self.cameraAttempt {
                self.stopCameraAttempt(attempt.attemptId)
            }
            self.filePicker.present(from: presenter, source: args.source, limit: limit) { result in
                switch result {
                case .success(let selections):
                    if let library {
                        do {
                            invoke.resolve(MediaLibraryResponse(items: try library.append(selections)))
                        } catch {
                            invoke.reject("AeRift could not save the imported copies.")
                        }
                        return
                    }
                    invoke.resolve(BatchPickerResponse(selections: selections.map {
                        .init(path: $0.url.path, name: $0.name, sizeBytes: $0.sizeBytes, kind: $0.kind)
                    }))
                case .failure(let error):
                    let message: String
                    if let staging = error as? StagingError {
                        switch staging {
                        case .limitExceeded:
                            message = "AeRift has reached its 512 MiB import limit. Choose a smaller file or clear earlier selections."
                        case .insufficientSpace:
                            message = "Free up space on this iPhone before importing this item."
                        case .invalidFile:
                            message = "AeRift could not read this file."
                        }
                    } else {
                        switch error as? FilePickerError {
                        case .alreadyPresenting:
                            message = "A file chooser is already open."
                        case .unavailable:
                            message = "The file chooser is unavailable."
                        case .tooManyItems:
                            message = "Choose fewer items and try again."
                        default:
                            message = "AeRift could not import this item."
                        }
                    }
                    invoke.reject(message)
                }
            }
        }
    }

    @objc func clipboardImageAvailable(_ invoke: Invoke) {
        if #available(iOS 16.0, *) {
            invoke.resolve(ClipboardImageCapability(supported: true))
        } else {
            invoke.resolve(ClipboardImageCapability(supported: false))
        }
    }

    @objc func pasteClipboardImage(_ invoke: Invoke) {
        DispatchQueue.main.async {
            guard #available(iOS 16.0, *), UIApplication.shared.applicationState == .active,
                  let presenter = self.manager.viewController,
                  presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else {
                invoke.reject("The image paste sheet is unavailable.")
                return
            }
            if let attempt = self.cameraAttempt {
                self.stopCameraAttempt(attempt.attemptId)
            }
            let picker = ClipboardImagePicker { result in
                switch result {
                case .success(let selected):
                    invoke.resolve(PickerResponse(selection: selected.map {
                        .init(path: $0.url.path, name: $0.name, sizeBytes: $0.sizeBytes)
                    }))
                case .failure:
                    invoke.reject("AeRift could not prepare the pasted image.")
                }
            }
            presenter.present(picker, animated: true)
        }
    }

    @objc func listMedia(_ invoke: Invoke) {
        DispatchQueue.main.async {
            do {
                invoke.resolve(MediaLibraryResponse(items: try self.openMediaLibrary().list()))
            } catch {
                invoke.reject("AeRift could not read the import library.")
            }
        }
    }

    @objc func removeMedia(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(MediaAssetArgs.self)
        DispatchQueue.main.async {
            do {
                invoke.resolve(MediaLibraryResponse(items: try self.openMediaLibrary().remove(args.assetId)))
            } catch {
                invoke.reject("AeRift could not remove this imported copy.")
            }
        }
    }

    @objc func stageMedia(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(MediaAssetArgs.self)
        DispatchQueue.main.async {
            do {
                let file = try self.openMediaLibrary().stage(args.assetId)
                invoke.resolve(PickerResponse(selection: .init(
                    path: file.url.path, name: file.name, sizeBytes: file.sizeBytes, kind: file.kind
                )))
            } catch {
                invoke.reject("AeRift could not reopen this imported copy.")
            }
        }
    }

    @objc func presentSelection(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SelectionArgs.self)
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active,
                  let presenter = self.manager.viewController,
                  let view = presenter.viewIfLoaded, view.window != nil,
                  presenter.presentedViewController == nil else {
                invoke.reject("Open AeRift to view this item.")
                return
            }

            // Only Rust calls this adapter, with the path of an owned selection.
            let url = URL(fileURLWithPath: args.path)
            if args.action == "preview" {
                let preview = SelectionPreview(url: url) { [weak self] in
                    self?.selectionPreview = nil
                    invoke.resolve()
                }
                guard QLPreviewController.canPreview(preview.item) else {
                    invoke.reject("Quick Look does not support this item.")
                    return
                }
                let controller = QLPreviewController()
                controller.dataSource = preview
                controller.delegate = preview
                controller.modalPresentationStyle = .fullScreen
                self.selectionPreview = preview
                presenter.present(controller, animated: true)
            } else if args.action == "export" {
                let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                controller.popoverPresentationController?.sourceView = view
                controller.popoverPresentationController?.sourceRect = CGRect(
                    x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1
                )
                controller.completionWithItemsHandler = { _, _, _, error in
                    if let error {
                        invoke.reject(error.localizedDescription)
                    } else {
                        invoke.resolve()
                    }
                }
                presenter.present(controller, animated: true)
            } else {
                invoke.reject("Unknown selection action.")
            }
        }
    }

    @objc func stageText(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(TextArgs.self)
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active else {
                invoke.reject("Open AeRift to prepare text.")
                return
            }
            do {
                let selection = try FileStaging.stageText(args.text, name: args.name)
                invoke.resolve(PickerResponse(selection: .init(
                    path: selection.url.path, name: selection.name, sizeBytes: selection.sizeBytes
                )))
            } catch {
                invoke.reject("AeRift could not prepare this text for transfer.")
            }
        }
    }

    @objc func openBrowser(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(BrowserArgs.self)
        guard let components = URLComponents(string: args.url),
              let scheme = components.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              let url = components.url else {
            invoke.reject("Enter a valid web address.")
            return
        }
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active,
                  let presenter = self.manager.viewController,
                  presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else {
                invoke.reject("The browser is unavailable.")
                return
            }
            presenter.present(SFSafariViewController(url: url), animated: true)
            invoke.resolve()
        }
    }

    @objc func startDiscovery(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(DiscoveryArgs.self)
        DispatchQueue.main.async {
            do {
                try self.discovery.start(id: args.id, name: args.name, port: args.port) { update in
                    try? args.events.send(update)
                }
                invoke.resolve()
            } catch BonjourError.busy {
                invoke.reject("AeRift discovery is already running.")
            } catch {
                invoke.reject("AeRift could not start local discovery.")
            }
        }
    }

    @objc func stopDiscovery(_ invoke: Invoke) {
        DispatchQueue.main.async {
            self.discovery.stop()
            invoke.resolve()
        }
    }

    @objc func cameraClock(_ invoke: Invoke) {
        invoke.resolve(CameraClock(clockMs: HandCamera.clockMs()))
    }

    @objc func cameraPermission(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(CameraPermissionRequest.self)
        Task { @MainActor in
            if args.request, UIApplication.shared.applicationState == .active,
               AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
                _ = await AVCaptureDevice.requestAccess(for: .video)
            }

            let status: String
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .notDetermined: status = "notDetermined"
            case .authorized: status = "authorized"
            case .denied: status = "denied"
            case .restricted: status = "restricted"
            @unknown default: status = "unavailable"
            }
            invoke.resolve(CameraPermission(status: status))
        }
    }

    @objc func startCamera(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(CameraArgs.self)
        guard !args.attemptId.isEmpty, args.attemptId.utf8.count <= 128 else {
            invoke.reject("Invalid camera attempt.")
            return
        }
        Task { @MainActor in
            guard !cancelledAttempts.contains(args.attemptId) else {
                try? args.events.send(CameraUpdate.status("disabled", attemptId: args.attemptId))
                invoke.resolve()
                return
            }
            guard cameraAttempt == nil else {
                try? args.events.send(CameraUpdate.status("busy", attemptId: args.attemptId))
                invoke.resolve()
                return
            }
            cameraAttempt = args
            try? args.events.send(CameraUpdate.status("requesting", attemptId: args.attemptId))
            do {
                try await handCamera.start(
                    onFrame: { frame in
                        try? args.events.send(CameraUpdate.landmarks(frame, attemptId: args.attemptId))
                    },
                    onStop: { reason in
                        self.finishCameraAttempt(args.attemptId, reason: reason)
                    }
                )
                if cameraAttempt?.attemptId == args.attemptId {
                    try? args.events.send(CameraUpdate.status("ready", attemptId: args.attemptId))
                }
            } catch {
                finishCameraAttempt(args.attemptId, reason: error as? HandCameraError ?? .captureFailed)
            }
            invoke.resolve()
        }
    }

    @objc func stopCamera(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(CameraStop.self)
        DispatchQueue.main.async {
            self.stopCameraAttempt(args.attemptId)
            invoke.resolve()
        }
    }

    @MainActor private func stopCameraAttempt(_ id: String) {
        // Stop can reach the bridge while its matching start is queued.
        if !cancelledAttempts.contains(id) {
            cancelledAttempts.append(id)
            if cancelledAttempts.count > 32 { cancelledAttempts.removeFirst() }
        }
        guard cameraAttempt?.attemptId == id else { return }
        handCamera.stop()
        finishCameraAttempt(id, reason: nil)
    }

    @MainActor private func finishCameraAttempt(_ id: String, reason: HandCameraError?) {
        guard let args = cameraAttempt, args.attemptId == id else { return }
        cameraAttempt = nil
        let state: String
        switch reason {
        case nil: state = "disabled"
        case .permissionDenied: state = "denied"
        case .inactive, .interrupted: state = "suspended"
        case .unavailable: state = "unavailable"
        case .busy: state = "busy"
        case .captureFailed: state = "error"
        }
        try? args.events.send(CameraUpdate.status(state, attemptId: id))
    }
}

@_cdecl("init_plugin_aerift_ios")
public func initPlugin() -> Plugin {
    AeRiftPlugin()
}
