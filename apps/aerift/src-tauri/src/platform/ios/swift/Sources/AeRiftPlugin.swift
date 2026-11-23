import Tauri
import UIKit

private struct PickerResponse: Encodable {
    struct Selection: Encodable {
        let path: String
        let name: String
        let sizeBytes: Int
    }

    let selection: Selection?
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
    @MainActor private lazy var filePicker = FilePicker()
    @MainActor private lazy var handCamera = HandCamera()
    @MainActor private var cameraAttempt: CameraArgs?
    @MainActor private var cancelledAttempts: [String] = []
    @MainActor private lazy var discovery = BonjourDiscovery()

    @objc func pickFile(_ invoke: Invoke) {
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active,
                  let presenter = self.manager.viewController else {
                invoke.reject("Open AeRift to choose an item.")
                return
            }

            if let attempt = self.cameraAttempt {
                self.stopCameraAttempt(attempt.attemptId)
            }
            self.filePicker.present(from: presenter) { result in
                switch result {
                case .success(let selection):
                    invoke.resolve(PickerResponse(selection: selection.map {
                        .init(path: $0.url.path, name: $0.name, sizeBytes: $0.sizeBytes)
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
                        default:
                            message = "AeRift could not import this item."
                        }
                    }
                    invoke.reject(message)
                }
            }
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
            } catch BonjourError.inactive {
                invoke.reject("Open AeRift to discover nearby devices.")
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
