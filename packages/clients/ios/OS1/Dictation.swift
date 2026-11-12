import AVFoundation
import Foundation
import Observation
import Speech

/// Speech-to-text for the composer: hold the mic open, stream what's said into
/// the draft, and get out of the way. This is dictation, NOT the Desk's voice
/// call (`DeskVoiceEngine`) — nothing is sent anywhere, no model is involved,
/// and the result is ordinary text the person can edit before sending.
///
/// Recognition prefers Apple's on-device path whenever the device offers it
/// (`supportsOnDeviceRecognition`): a workspace composer routinely carries
/// customer names, internal URLs and ticket details, and the server route
/// would ship that audio to Apple for transcription. On-device keeps it here.
@MainActor
@Observable
final class Dictation {
    enum State: Equatable {
        case idle
        case listening
        /// Permission refused — the message names which one, since the fix
        /// differs (mic vs speech recognition) and both live in Settings.
        case denied(String)
        case failed(String)
    }

    private(set) var state: State = .idle

    var active: Bool { state == .listening }

    /// When the current utterance started listening, for the recording timer.
    private(set) var startedAt: Date?
    /// Recent input levels, 0...1, newest last. Read only by the recording
    /// pills, so the composer itself never re-evaluates on a level tick.
    private(set) var levels: [Float] = []
    private static let maxLevels = 24
    private var lastLevelAt = Date.distantPast

    /// Non-nil only while a session is running: the recognizer hands back the
    /// whole utterance each time, so the caller needs the draft as it was when
    /// dictation started to append onto.
    private var base = ""
    private var onTranscript: ((String) -> Void)?

    private let audio = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    /// - Parameters:
    ///   - base: the draft as it stands; dictated text is appended to it, so
    ///     dictating into a half-typed message adds to it rather than
    ///     replacing what's there.
    ///   - contextualStrings: names and terms the recognizer should expect
    ///     (Blob's glossary); at most 100 are used.
    ///   - onTranscript: called with the full draft (base + speech) on every
    ///     partial result.
    func start(
        base: String,
        contextualStrings: [String] = [],
        onTranscript: @escaping (String) -> Void
    ) async {
        guard state != .listening else { return }
        self.base = base
        self.onTranscript = onTranscript

        guard await requestSpeechAuthorization() else {
            state = .denied("Speech recognition is off. Turn it on for \(AppBrand.appName) in Settings to dictate.")
            return
        }
        guard await requestMicPermission() else {
            state = .denied("Microphone access is off. Turn it on for \(AppBrand.appName) in Settings to dictate.")
            return
        }

        let recognizer = SFSpeechRecognizer()
        guard let recognizer, recognizer.isAvailable else {
            state = .failed("Dictation isn't available right now.")
            return
        }
        self.recognizer = recognizer

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.contextualStrings = Array(contextualStrings.prefix(100))
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request

        do {
            try configureAudioSession()
            try startCapture(into: request)
        } catch {
            teardown()
            state = .failed("Couldn't start the microphone.")
            return
        }

        levels = []
        startedAt = Date()
        state = .listening
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            // The recognizer calls back off the main actor.
            Task { @MainActor in
                guard let self, self.state == .listening else { return }
                if let result {
                    self.emit(result.bestTranscription.formattedString)
                    // A final result ends this utterance; the mic stays the
                    // person's to reopen rather than restarting under them.
                    if result.isFinal { self.stop() }
                    return
                }
                if error != nil {
                    // A cancelled task reports an error too; only surface one
                    // that arrives while we still believed we were listening.
                    self.stop()
                }
            }
        }
    }

    func stop() {
        guard state != .idle else { return }
        teardown()
        if state == .listening { state = .idle }
    }

    #if DEBUG
    /// Listening state with a still level history, for headless captures.
    func showForScreenshot() {
        startedAt = Date().addingTimeInterval(-7)
        levels = (0..<Self.maxLevels).map { Float(0.25 + 0.6 * abs(sin(Double($0) * 0.9))) }
        state = .listening
    }
    #endif

    /// Clears a refusal/failure so the next tap tries again rather than
    /// showing a stale complaint.
    func clearError() {
        if case .listening = state { return }
        state = .idle
    }

    private func emit(_ spoken: String) {
        let trimmed = spoken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let prefix = base.trimmingCharacters(in: .whitespacesAndNewlines)
        onTranscript?(prefix.isEmpty ? trimmed : prefix + " " + trimmed)
    }

    // MARK: - Permissions

    /// Both permissions already granted — so a caller that opens the mic on
    /// its own (the Action Button's "Start an Agent", `StartAgentIntent`) can hold
    /// off rather than stacking two system prompts over a sheet the person
    /// did not ask for them from. Tapping the mic still asks, as always.
    static var isAuthorized: Bool {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else { return false }
        #if os(iOS)
        return AVAudioApplication.shared.recordPermission == .granted
        #else
        return AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        #endif
    }

    private func requestSpeechAuthorization() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .denied, .restricted: return false
        default:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status == .authorized)
                }
            }
        }
    }

    private func requestMicPermission() async -> Bool {
        #if os(iOS)
        await AVAudioApplication.requestRecordPermission()
        #else
        await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                continuation.resume(returning: granted)
            }
        }
        #endif
    }

    // MARK: - Capture

    private func configureAudioSession() throws {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        // `.record`, not the call's `.playAndRecord`: dictation has nothing to
        // play, and taking the output route would duck whatever else is.
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true)
        #endif
    }

    private func startCapture(into request: SFSpeechAudioBufferRecognitionRequest) throws {
        let input = audio.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self] buffer, _ in
            request.append(buffer)
            let level = Self.rms(buffer)
            Task { @MainActor in self?.pushLevel(level) }
        }
        audio.prepare()
        try audio.start()
    }

    /// Root mean square of the first channel, scaled so speech fills the meter.
    nonisolated private static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<count { sum += samples[i] * samples[i] }
        return min(1, (sum / Float(count)).squareRoot() * 6)
    }

    /// Throttled to the meter's frame rate; the tap fires roughly every 20ms.
    private func pushLevel(_ level: Float) {
        guard state == .listening else { return }
        let now = Date()
        guard now.timeIntervalSince(lastLevelAt) >= 0.08 else { return }
        lastLevelAt = now
        levels.append(level)
        if levels.count > Self.maxLevels { levels.removeFirst(levels.count - Self.maxLevels) }
    }

    /// Safe to call more than once — both `stop()` and the failure paths run it.
    private func teardown() {
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        recognizer = nil
        onTranscript = nil
        base = ""
        startedAt = nil
        levels = []
        if audio.isRunning { audio.stop() }
        audio.inputNode.removeTap(onBus: 0)
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}
