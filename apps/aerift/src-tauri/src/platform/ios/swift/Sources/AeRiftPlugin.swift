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
    let events: Channel
}

private struct CameraUpdate: Encodable {
    let kind: String
    let frame: HandFrame?
    let reason: String?
}

final class AeRiftPlugin: Plugin {
    @MainActor private lazy var filePicker = FilePicker()
    @MainActor private lazy var handCamera = HandCamera()

    @objc func pickFile(_ invoke: Invoke) {
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active,
                  let presenter = self.manager.viewController else {
                invoke.reject("Open AeRift to choose an item.")
                return
            }

            self.handCamera.stop()
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

    @objc func startCamera(_ invoke: Invoke) throws {
        let channel = try invoke.parseArgs(CameraArgs.self).events
        Task { @MainActor in
            do {
                try await handCamera.start(
                    onFrame: { frame in
                        try? channel.send(CameraUpdate(kind: "frame", frame: frame, reason: nil))
                    },
                    onStop: { reason in
                        try? channel.send(CameraUpdate(kind: "stopped", frame: nil, reason: reason?.rawValue))
                    }
                )
                invoke.resolve()
            } catch {
                invoke.reject((error as? HandCameraError ?? .captureFailed).rawValue)
            }
        }
    }

    @objc func stopCamera(_ invoke: Invoke) {
        DispatchQueue.main.async {
            self.handCamera.stop()
            invoke.resolve()
        }
    }
}

@_cdecl("init_plugin_aerift_ios")
public func initPlugin() -> Plugin {
    AeRiftPlugin()
}
