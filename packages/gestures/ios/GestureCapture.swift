import AVFoundation
import CoreMedia
import ImageIO
import UIKit
import Vision

/// A foreground, portrait front-camera provider for the shared AeRift gesture engine.
/// Callbacks arrive on the main queue. Only normalized joints and timestamps cross the bridge.
final class GestureCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    struct Joint: Encodable {
        let x: Double
        let y: Double
        let z: Double = 0 // Vision provides 2D joints. Do not synthesize depth.
        let confidence: Float
    }

    struct Frame: Encodable {
        let captureMs: Double
        let width: Int
        let height: Int
        let hands: [[Joint]]
    }

    enum Event: Encodable {
        case state(String, String) // attempt ID, CameraState
        case frame(String, Frame)

        private enum CodingKeys: String, CodingKey { case type, attemptId, state, frame }

        func encode(to encoder: Encoder) throws {
            var event = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case let .state(id, state):
                try event.encode("state", forKey: .type)
                try event.encode(id, forKey: .attemptId)
                try event.encode(state, forKey: .state)
            case let .frame(id, frame):
                try event.encode("frame", forKey: .type)
                try event.encode(id, forKey: .attemptId)
                try event.encode(frame, forKey: .frame)
            }
        }
    }

    private let queue = DispatchQueue(label: "com.aerift.gesture-capture", qos: .userInitiated)
    private let emit: (Event) -> Void
    private var attempt: String?
    private var session: AVCaptureSession?
    private var output: AVCaptureVideoDataOutput?
    private var lastCaptureMs = -Double.infinity
    private let request = VNDetectHumanHandPoseRequest()
    private var observers: [NSObjectProtocol] = []
    private let frameDelivery = DispatchSemaphore(value: 1)

    private static let joints: [VNHumanHandPoseObservation.JointName] = [
        .wrist, .thumbCMC, .thumbMP, .thumbIP, .thumbTip,
        .indexMCP, .indexPIP, .indexDIP, .indexTip,
        .middleMCP, .middlePIP, .middleDIP, .middleTip,
        .ringMCP, .ringPIP, .ringDIP, .ringTip,
        .littleMCP, .littlePIP, .littleDIP, .littleTip
    ]

    init(emit: @escaping (Event) -> Void) {
        self.emit = emit
        super.init()
        request.maximumHandCount = 2
    }

    static func clockMs() -> Double { CMClockGetTime(CMClockGetHostTimeClock()).seconds * 1_000 }

    @MainActor
    private static var isForegroundPortrait: Bool {
        UIApplication.shared.applicationState == .active &&
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .contains { $0.activationState == .foregroundActive && $0.interfaceOrientation == .portrait }
    }

    /// The host calls this in response to a foreground user action. Keep one provider per host.
    func start(_ id: String) {
        DispatchQueue.main.async {
            guard Self.isForegroundPortrait else {
                self.emit(.state(id, "unavailable"))
                return
            }
            self.queue.async {
                guard self.attempt == nil else {
                    self.send(.state(id, "busy"))
                    return
                }
                self.attempt = id
                switch AVCaptureDevice.authorizationStatus(for: .video) {
                case .authorized: self.configure(id)
                case .notDetermined:
                    self.send(.state(id, "requesting"))
                    AVCaptureDevice.requestAccess(for: .video) { granted in
                        DispatchQueue.main.async {
                            let active = Self.isForegroundPortrait
                            self.queue.async {
                                guard self.attempt == id else { return }
                                if !granted { self.finish("denied") }
                                else if !active { self.finish("suspended") }
                                else { self.configure(id) }
                            }
                        }
                    }
                case .denied, .restricted: self.finish("denied")
                @unknown default: self.finish("unavailable")
                }
            }
        }
    }

    func stop(_ id: String) {
        DispatchQueue.main.async {
            self.interrupt(id, state: "disabled")
        }
    }

    private func configure(_ id: String) {
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
              let input = try? AVCaptureDeviceInput(device: camera) else {
            finish("unavailable")
            return
        }
        send(.state(id, "starting"))
        let session = AVCaptureSession()
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        session.beginConfiguration()
        if session.canSetSessionPreset(.vga640x480) { session.sessionPreset = .vga640x480 }
        guard session.canAddInput(input), session.canAddOutput(output) else {
            session.commitConfiguration()
            finish("unavailable")
            return
        }
        session.addInput(input)
        session.addOutput(output)
        if let connection = output.connection(with: .video), connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = false
        }
        output.setSampleBufferDelegate(self, queue: queue)
        session.commitConfiguration()
        self.session = session
        self.output = output
        lastCaptureMs = -Double.infinity

        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: nil) { [weak self] _ in
                self?.interrupt(id, state: "suspended")
            },
            center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: nil) { [weak self] _ in
                self?.interrupt(id, state: "suspended")
            },
            center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] _ in
                self?.interrupt(id, state: "error")
            },
        ]
        session.startRunning()
        if session.isRunning { send(.state(id, "ready")) }
        else { finish("error") }
    }

    private func interrupt(_ id: String, state: String) {
        queue.async {
            if self.attempt == id { self.finish(state) }
        }
    }

    private func finish(_ state: String) {
        guard let id = attempt else { return }
        attempt = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        output?.setSampleBufferDelegate(nil, queue: nil)
        session?.stopRunning()
        output = nil
        session = nil
        send(.state(id, state))
    }

    private func send(_ event: Event) {
        DispatchQueue.main.async { self.emit(event) }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard let id = attempt, output === self.output,
              let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let sourceClock: CMClock?
        if #available(iOS 15.4, *) { sourceClock = session?.synchronizationClock }
        else { sourceClock = session?.masterClock }
        guard let sourceClock else { return }
        let at = sourceClock.convertTime(sampleBuffer.presentationTimeStamp, to: CMClockGetHostTimeClock()).seconds * 1_000
        let age = Self.clockMs() - at
        guard age.isFinite, age >= 0, age <= 150 else { return }
        guard at - lastCaptureMs >= 40, frameDelivery.wait(timeout: .now()) == .success else { return }
        lastCaptureMs = at
        do {
            // Unmirrored landscape sensor buffer rotated into the portrait image.
            try VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .left).perform([request])
            let hands = (request.results ?? []).map { observation in
                Self.joints.compactMap { name -> Joint? in
                    guard let point = try? observation.recognizedPoint(name) else { return nil }
                    return Joint(x: Double(point.location.x), y: 1 - Double(point.location.y), confidence: point.confidence)
                }
            }
            let frame = Frame(captureMs: at, width: CVPixelBufferGetHeight(pixels),
                              height: CVPixelBufferGetWidth(pixels), hands: hands)
            DispatchQueue.main.async {
                defer { self.frameDelivery.signal() }
                guard Self.isForegroundPortrait else {
                    self.interrupt(id, state: "suspended")
                    return
                }
                self.emit(.frame(id, frame))
            }
        } catch {
            frameDelivery.signal()
            finish("error")
        }
    }
}
