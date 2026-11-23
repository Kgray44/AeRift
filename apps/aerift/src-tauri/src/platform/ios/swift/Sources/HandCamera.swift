import AVFoundation
import CoreMedia
import UIKit
import Vision

struct HandLandmark: Encodable {
    let x: Double
    let y: Double
    let confidence: Double
}

struct HandFrame: Encodable {
    let timestampMs: Double
    let frameWidth: Int
    let frameHeight: Int
    /// Vision's 21 joints in the shared landmark order. The origin is top-left.
    let hands: [[HandLandmark]]
}

enum HandCameraError: String, Error {
    case busy
    case inactive
    case permissionDenied
    case unavailable
    case interrupted
    case captureFailed
}

@MainActor
final class HandCamera: NSObject {
    private var generation: UUID?
    private var capture: HandCapture?
    private var onStop: ((HandCameraError?) -> Void)?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(willResignActive(_:)), name: UIApplication.willResignActiveNotification, object: nil
        )
    }

    func start(
        onFrame: @escaping (HandFrame) -> Void,
        onStop: @escaping (HandCameraError?) -> Void
    ) async throws {
        guard generation == nil else { throw HandCameraError.busy }
        guard UIApplication.shared.applicationState == .active else { throw HandCameraError.inactive }

        let ticket = UUID()
        generation = ticket
        do {
            if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
                let allowed = await AVCaptureDevice.requestAccess(for: .video)
                guard allowed else { throw HandCameraError.permissionDenied }
            }
            guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
                throw HandCameraError.permissionDenied
            }
            guard generation == ticket, UIApplication.shared.applicationState == .active else {
                throw HandCameraError.inactive
            }

            let source = HandCapture { [weak self] frame in
                let deliveredAt = DispatchTime.now().uptimeNanoseconds
                DispatchQueue.main.async {
                    guard self?.generation == ticket,
                          DispatchTime.now().uptimeNanoseconds - deliveredAt < 220_000_000 else { return }
                    onFrame(frame)
                }
            }
            capture = source
            self.onStop = onStop
            let center = NotificationCenter.default
            center.addObserver(self, selector: #selector(captureInterrupted),
                               name: AVCaptureSession.wasInterruptedNotification, object: source.session)
            center.addObserver(self, selector: #selector(captureFailed),
                               name: AVCaptureSession.runtimeErrorNotification, object: source.session)
            try await source.start()
            guard generation == ticket else { throw HandCameraError.interrupted }
        } catch {
            if generation == ticket { stop(reason: nil) }
            throw error
        }
    }

    func stop() {
        stop(reason: nil)
    }

    @objc private func willResignActive(_ notification: Notification) {
        // The system camera permission prompt can temporarily deactivate the app.
        if capture != nil { stop(reason: .inactive) }
    }

    @objc nonisolated private func captureInterrupted(_ notification: Notification) {
        guard let source = notification.object as? AVCaptureSession else { return }
        DispatchQueue.main.async {
            if self.capture?.session === source { self.stop(reason: .interrupted) }
        }
    }

    @objc nonisolated private func captureFailed(_ notification: Notification) {
        guard let source = notification.object as? AVCaptureSession else { return }
        DispatchQueue.main.async {
            if self.capture?.session === source { self.stop(reason: .captureFailed) }
        }
    }

    private func stop(reason: HandCameraError?) {
        generation = nil
        let callback = onStop
        onStop = nil
        if let capture {
            let center = NotificationCenter.default
            center.removeObserver(self, name: AVCaptureSession.wasInterruptedNotification, object: capture.session)
            center.removeObserver(self, name: AVCaptureSession.runtimeErrorNotification, object: capture.session)
            capture.stop()
        }
        capture = nil
        callback?(reason)
    }
}

private final class HandCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private static let queue = DispatchQueue(label: "com.aerift.hand-camera", qos: .userInitiated)
    private let request = VNDetectHumanHandPoseRequest()
    private let onFrame: (HandFrame) -> Void
    private var lastFrameMs = -Double.infinity

    private static let jointOrder: [VNHumanHandPoseObservation.JointName] = [
        .wrist,
        .thumbCMC, .thumbMP, .thumbIP, .thumbTip,
        .indexMCP, .indexPIP, .indexDIP, .indexTip,
        .middleMCP, .middlePIP, .middleDIP, .middleTip,
        .ringMCP, .ringPIP, .ringDIP, .ringTip,
        .littleMCP, .littlePIP, .littleDIP, .littleTip
    ]

    init(onFrame: @escaping (HandFrame) -> Void) {
        self.onFrame = onFrame
        super.init()
        request.maximumHandCount = 2
    }

    func start() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            Self.queue.async {
                do {
                    try self.configure()
                    self.session.startRunning()
                    guard self.session.isRunning else { throw HandCameraError.captureFailed }
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func stop() {
        Self.queue.async {
            self.output.setSampleBufferDelegate(nil, queue: nil)
            self.session.stopRunning()
        }
    }

    private func configure() throws {
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
            throw HandCameraError.unavailable
        }
        let input = try AVCaptureDeviceInput(device: camera)
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .vga640x480
        guard session.canAddInput(input), session.canAddOutput(output) else {
            throw HandCameraError.captureFailed
        }
        session.addInput(input)
        session.addOutput(output)
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: Self.queue)
        if let connection = output.connection(with: .video) {
            if #available(iOS 17.0, *) {
                if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
            } else if connection.isVideoOrientationSupported {
                connection.videoOrientation = .portrait
            }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        let timestamp = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1_000
        guard timestamp.isFinite, timestamp - lastFrameMs >= 75,
              let image = CMSampleBufferGetImageBuffer(sample) else { return }
        lastFrameMs = timestamp

        let handler = VNImageRequestHandler(cmSampleBuffer: sample, orientation: .up)
        var hands: [[HandLandmark]] = []
        if (try? handler.perform([request])) != nil {
            hands = (request.results ?? []).map { observation in
                Self.jointOrder.map { joint in
                    guard let point = try? observation.recognizedPoint(joint) else {
                        return HandLandmark(x: 0, y: 0, confidence: 0)
                    }
                    return HandLandmark(x: Double(point.x), y: 1 - Double(point.y), confidence: Double(point.confidence))
                }
            }
        }
        onFrame(HandFrame(timestampMs: timestamp, frameWidth: CVPixelBufferGetWidth(image),
                          frameHeight: CVPixelBufferGetHeight(image), hands: hands))
    }
}
