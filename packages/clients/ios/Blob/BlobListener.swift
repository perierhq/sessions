import AVFoundation
import FluidAudio
import Foundation
import Observation
import Speech

/// Hears you for Blob's text mode. Uses Apple's on-device `SpeechAnalyzer`
/// with `SpeechTranscriber` (iOS 26), which mishears far less than the old
/// `SFSpeechRecognizer`, and falls back to the OS app's `Dictation` for a
/// language the new model doesn't cover.
///
/// Apple's text is the live caption. The same microphone audio is also kept
/// in memory as 16 kHz mono samples, so `BlobTextTalk` can have Parakeet
/// (`BlobParakeet`) or the server's Fish Audio write the final text. The
/// samples feed `BlobEndpointer` too, through FluidAudio's voice activity
/// model, so listening ends by itself once you stop talking (`onEnd`).
@MainActor
@Observable
final class BlobListener {
    enum ListenError: LocalizedError {
        case microphoneOff
        var errorDescription: String? {
            "Microphone access is off. Turn it on for \(AppBrand.appName) in Settings."
        }
    }

    /// Everything heard so far: finished phrases plus the one still forming.
    private(set) var text = ""
    /// 0…1 input loudness, for Blob's halo.
    private(set) var level: Double = 0
    /// First use downloads the speech model for your language.
    private(set) var preparing = false
    /// Listening ends by itself when you stop talking. False on the
    /// `Dictation` fallback, which has no recording to judge by: tap to send.
    var endsByItself: Bool { fallback == nil }
    /// Called once when the endpointer decides: `.send` after you stop
    /// talking, `.giveUp` when nothing was said.
    var onEnd: ((BlobEndpointer.Decision) -> Void)?
    /// Apple's text has not changed for `stillHint` seconds while you are
    /// still being listened to: the captions ask for a tap.
    private(set) var textStill = false
    /// The last `.send` came from Apple's text standing still for
    /// `stillEnd` seconds, not from the VAD or the input level.
    private(set) var endedByStillText = false
    /// The endpointer decided only at `BlobEndpointer.maxListen`: it never
    /// heard you stop.
    private(set) var endedAtCap = false

    /// Seconds of unchanged text before the captions ask for a tap. Only
    /// reached where the text doesn't end the listen (`stillEnd`): on the
    /// `Dictation` fallback.
    static let stillHint: Double = 4
    /// Seconds of unchanged text that end the listen like a pause would.
    /// The VAD may still be loading on a fresh install (the Neural Engine
    /// is busy with Parakeet), and the input level never goes quiet in a
    /// noisy room, so neither may ever decide; the words you said have.
    static let stillEnd: Double = 2.5
    static let log = BlobLog(category: "listener")

    /// What `stop()` hands back: Apple's text and the recording behind it.
    struct Heard {
        let text: String
        /// 16 kHz mono Float32; empty on the `Dictation` fallback.
        let samples: [Float]
        /// False when the model missed `stop`'s deadline and `text` is what
        /// it had shown by then.
        var finished = true
    }

    private var finalized = ""
    private var engine: AVAudioEngine?
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var results: Task<Void, Never>?
    private var fallback: Dictation?
    private var capture: BlobCapture?
    private var endpointer = BlobEndpointer()
    private var ended = false
    private var voiceActivity: Task<Void, Never>?
    /// Off the main actor's level path once the VAD is deciding.
    private var usesVoiceActivity = false
    private var wasSpeaking = false
    /// When Apple's text last changed, and the task watching it stand still.
    private var wordsAt: ContinuousClock.Instant?
    private var stillness: Task<Void, Never>?

    /// Input level above which a buffer counts as speech when the VAD isn't
    /// loaded. An assumption tuned by ear against `level`'s 0…1 scale.
    static let speechLevel = 0.15
    /// Listening has the audio session: `deactivateSession` leaves it alone.
    private var holdsSession = false {
        didSet { Self.listening += holdsSession == oldValue ? 0 : (holdsSession ? 1 : -1) }
    }
    private static var listening = 0
    /// Playback that still uses the session (Blob's voice, the filler),
    /// registered by its owner. Asked when the session would be released.
    private static var playbackChecks: [() -> Bool] = []
    private static var deactivation: Task<Void, Never>?

    static func registerPlayback(_ isPlaying: @escaping () -> Bool) {
        playbackChecks.append(isPlaying)
    }

    func start() async throws {
        text = ""; finalized = ""; level = 0
        endpointer = BlobEndpointer(); ended = false; wasSpeaking = false
        wordsAt = nil; textStill = false; endedByStillText = false; endedAtCap = false
        guard await AVAudioApplication.requestRecordPermission() else { throw ListenError.microphoneOff }
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)
        else { return await startFallback() }

        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            Self.log.info("speech model install")
            preparing = true
            defer { preparing = false }
            try await install.downloadAndInstall()
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        usesVoiceActivity = false
        let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.analyzer = analyzer
        input = continuation
        results = Task { [weak self] in
            do {
                for try await result in transcriber.results { self?.apply(result) }
            } catch {}
        }
        try Self.activateSession(record: true)
        holdsSession = true
        try await analyzer.start(inputSequence: stream)
        let vadState = await BlobVoiceActivity.shared.makeStreamState()
        if vadState == nil { Task.detached { _ = await BlobVoiceActivity.shared.load() } }
        let capture = BlobCapture(framing: vadState == nil ? nil : BlobVoiceActivity.frame)
        self.capture = capture
        if let vadState { startVoiceActivity(capture, state: vadState) }
        try startEngine(feeding: continuation, as: format, capture: capture)
        Self.log.info("start vad=\(vadState != nil) endpoint=\(vadState != nil ? "vad" : "level")")
        watchStillness()
    }

    /// Stops listening and returns everything heard, once the model has
    /// finished its last phrase, or after `seconds` with the text shown so
    /// far: the model can stall (a first Parakeet compile competing for the
    /// Neural Engine), and what you said must still go.
    func stop(within seconds: Double) async -> Heard {
        ended = true
        holdsSession = false
        stillness?.cancel(); stillness = nil
        if let fallback {
            fallback.stop()
            self.fallback = nil
            return Heard(text: text, samples: [])
        }
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        engine = nil
        input?.finish()
        input = nil
        let samples = capture?.finish() ?? []
        capture = nil
        voiceActivity?.cancel(); voiceActivity = nil
        // Taken before waiting: a new `start()` meanwhile owns the fields.
        let analyzer = self.analyzer, results = self.results
        self.analyzer = nil
        self.results = nil
        level = 0
        let finished = await Self.finishes(within: seconds) {
            try? await analyzer?.finalizeAndFinishThroughEndOfInput()
            await results?.value
        }
        if !finished {
            results?.cancel()
            if let analyzer { Task { await analyzer.cancelAndFinishNow() } }
        }
        return Heard(text: text, samples: samples, finished: finished)
    }

    /// Whether `work` ends within `seconds`. Returns at the deadline even
    /// when `work` never does.
    private static func finishes(within seconds: Double, _ work: @escaping @MainActor () async -> Void) async -> Bool {
        final class Once {
            var continuation: CheckedContinuation<Bool, Never>?
            func resume(_ value: Bool) { continuation?.resume(returning: value); continuation = nil }
        }
        let once = Once()
        return await withCheckedContinuation { continuation in
            once.continuation = continuation
            let timer = Task { @MainActor in
                try? await Task.sleep(for: .seconds(seconds))
                once.resume(false)
            }
            Task { @MainActor in
                await work()
                timer.cancel()
                once.resume(true)
            }
        }
    }

    /// Drops everything without waiting for the model.
    func cancel() {
        holdsSession = false
        stillness?.cancel(); stillness = nil
        fallback?.stop(); fallback = nil
        engine?.stop(); engine?.inputNode.removeTap(onBus: 0); engine = nil
        input?.finish(); input = nil
        _ = capture?.finish(); capture = nil
        voiceActivity?.cancel(); voiceActivity = nil
        ended = true
        results?.cancel(); results = nil
        if let analyzer { Task { await analyzer.cancelAndFinishNow() } }
        analyzer = nil
        level = 0
    }

    private func apply(_ result: SpeechTranscriber.Result) {
        let phrase = String(result.text.characters)
        let before = text
        if result.isFinal {
            finalized += phrase
            text = finalized
        } else {
            text = finalized + phrase
        }
        if text != before { heardWords() }
    }

    private func heardWords() {
        wordsAt = .now
        textStill = false
    }

    /// Ends the listen once Apple's text has stood still for `stillEnd`
    /// seconds, whatever the endpointer thinks, and logs what the
    /// endpointer is working from every 5 s.
    private func watchStillness() {
        stillness?.cancel()
        stillness = Task { [weak self] in
            var ticks = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                guard let self, !Task.isCancelled, !self.ended else { return }
                ticks += 1
                if ticks % 10 == 0 { self.logEndpointer("listening") }
                guard let at = self.wordsAt,
                      !self.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                else { continue }
                let still = Double(BlobMetrics.elapsedMs(since: at)) / 1000
                if still >= Self.stillHint, !self.textStill { self.textStill = true }
                // The `Dictation` fallback ends with your tap, as it says.
                if still >= Self.stillEnd, self.endsByItself {
                    self.logEndpointer("still text")
                    self.ended = true
                    self.endedByStillText = true
                    self.onEnd?(.send)
                    return
                }
            }
        }
    }

    private func logEndpointer(_ event: String) {
        let still = wordsAt.map { BlobMetrics.elapsedMs(since: $0) } ?? -1
        Self.log.info("\(event) endpoint=\(fallback != nil ? "dictation" : usesVoiceActivity ? "vad" : "level") elapsed=\(Int(endpointer.elapsed * 1000)) speech=\(Int(endpointer.speech * 1000)) silence=\(Int(endpointer.silence * 1000)) level=\(String(format: "%.2f", level)) chars=\(text.count) stillMs=\(still)")
    }

    /// One endpointer frame; acts on its decision once.
    private func endpoint(speaking: Bool, seconds: TimeInterval) {
        guard !ended else { return }
        let decision = endpointer.feed(speaking: speaking, seconds: seconds)
        guard decision != .listen else { return }
        endedAtCap = endpointer.elapsed >= BlobEndpointer.maxListen
        logEndpointer("decision=\(decision)")
        ended = true
        onEnd?(decision)
    }

    /// Runs the VAD over the recording, one 256 ms frame at a time.
    private func startVoiceActivity(_ capture: BlobCapture, state: VadStreamState) {
        usesVoiceActivity = true
        let frames = capture.frames
        voiceActivity = Task { [weak self] in
            var state = state
            let seconds = Double(BlobVoiceActivity.frame) / BlobCapture.sampleRate
            for await frame in frames {
                guard let (probability, next) = await BlobVoiceActivity.shared.probability(frame, state: state) else {
                    // The model failed: the input level decides from here.
                    Self.log.error("vad failed: level decides")
                    self?.usesVoiceActivity = false
                    return
                }
                state = next
                guard let self else { return }
                // Silero's own hysteresis: 0.5 to start speech, 0.35 to end it.
                let speaking = probability >= 0.5 || (self.wasSpeaking && probability >= 0.35)
                self.wasSpeaking = speaking
                self.endpoint(speaking: speaking, seconds: seconds)
            }
        }
    }

    private func startFallback() async {
        holdsSession = true
        let dictation = Dictation()
        fallback = dictation
        Self.log.info("start endpoint=dictation")
        watchStillness()
        await dictation.start(base: "") { [weak self] heard in
            guard let self else { return }
            if heard != self.text { self.heardWords() }
            self.text = heard
        }
    }

    private func startEngine(
        feeding continuation: AsyncStream<AnalyzerInput>.Continuation,
        as target: AVAudioFormat?,
        capture: BlobCapture
    ) throws {
        let engine = AVAudioEngine()
        let node = engine.inputNode
        let natural = node.outputFormat(forBus: 0)
        let converter = target.flatMap { $0 == natural ? nil : AVAudioConverter(from: natural, to: $0) }
        let recorder = AVAudioConverter(from: natural, to: BlobCapture.format)
        node.installTap(onBus: 0, bufferSize: 2048, format: natural) { [weak self] buffer, _ in
            let peak = Self.peak(of: buffer)
            let seconds = Double(buffer.frameLength) / natural.sampleRate
            if let converter, let target, let converted = Self.convert(buffer, with: converter, to: target) {
                continuation.yield(AnalyzerInput(buffer: converted))
            } else {
                continuation.yield(AnalyzerInput(buffer: buffer))
            }
            if let recorder, let recorded = Self.convert(buffer, with: recorder, to: BlobCapture.format) {
                capture.append(recorded)
            }
            Task { @MainActor in
                guard let self else { return }
                self.level = min(1, Double(peak) * 4)
                if !self.usesVoiceActivity { self.endpoint(speaking: self.level > Self.speechLevel, seconds: seconds) }
            }
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
    }

    nonisolated private static func peak(of buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0] else { return 0 }
        var peak: Float = 0
        for i in 0..<Int(buffer.frameLength) { peak = max(peak, abs(samples[i])) }
        return peak
    }

    nonisolated private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        return error == nil ? out : nil
    }

    /// Recording and speaking want different audio sessions; switching is cheap.
    ///
    /// Speaking (replies, decisions, asks, the filler) uses `.soloAmbient`,
    /// so the ring/silent switch holds: on silent Blob is quiet on the
    /// built-in speaker and still speaks in headphones and AirPods (A2DP,
    /// which the playback categories route to on their own). Apps can't read
    /// the switch, so this category is the only way to respect it.
    /// `.ambient` would respect it too, but it always mixes and can't duck
    /// (`.duckOthers` is only for `.playback`, `.playAndRecord` and
    /// `.multiRoute`), so Blob would talk over music at full volume; with
    /// `.soloAmbient` other audio pauses while Blob has the floor. Its mode
    /// stays `.default`: Apple lists `.spokenAudio` for `.playback` only.
    /// `overSilent` keeps `.playback` for a sound you asked to hear (the
    /// voice preview in Settings). Listening keeps `.playAndRecord`, with
    /// A2DP allowed so a Bluetooth output stays where it is while the
    /// built-in mic listens. The opt-in live call configures its own session
    /// (`DeskVoiceEngine`).
    static func activateSession(record: Bool, overSilent: Bool = false) throws {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        if record {
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothA2DP, .duckOthers])
        } else if overSilent {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        } else {
            try session.setCategory(.soloAmbient, mode: .default)
        }
        deactivation?.cancel()
        deactivation = nil
        try session.setActive(true)
        #endif
    }

    /// Gives the audio session back once Blob is quiet, so music that
    /// paused for Blob resumes. Waits a moment, so back-to-back segments
    /// keep it, and does nothing while anything still plays, you are being
    /// listened to, or a live call has the session.
    static func deactivateSession() {
        #if os(iOS)
        deactivation?.cancel()
        deactivation = Task { @MainActor in
            try? await Task.sleep(for: .seconds(0.3))
            guard !Task.isCancelled else { return }
            deactivation = nil
            guard listening == 0, !DeskVoiceEngine.supervisor.active,
                  !playbackChecks.contains(where: { $0() }) else { return }
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        #endif
    }
}

/// The recording `BlobListener` keeps while you talk: 16 kHz mono Float32,
/// the format Parakeet and the VAD take. Appended from the audio thread.
/// With `framing`, every full frame of that many samples also goes to
/// `frames` for the VAD.
final class BlobCapture: @unchecked Sendable {
    static let sampleRate: Double = 16_000
    static let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false
    )!
    /// A minute and a bit: the endpointer ends at 60 s.
    static let maxSamples = Int(sampleRate * 62)

    let frames: AsyncStream<[Float]>
    private let framing: Int?
    private let continuation: AsyncStream<[Float]>.Continuation
    private let lock = NSLock()
    private var samples: [Float] = []
    private var framed = 0

    init(framing: Int?) {
        self.framing = framing
        (frames, continuation) = AsyncStream<[Float]>.makeStream(bufferingPolicy: .bufferingNewest(16))
        samples.reserveCapacity(Int(Self.sampleRate * 10))
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData?[0] else { return }
        let count = Int(buffer.frameLength)
        var ready: [[Float]] = []
        lock.lock()
        if samples.count + count <= Self.maxSamples {
            samples.append(contentsOf: UnsafeBufferPointer(start: data, count: count))
        }
        if let framing {
            while samples.count - framed >= framing {
                ready.append(Array(samples[framed..<(framed + framing)]))
                framed += framing
            }
        }
        lock.unlock()
        for frame in ready { continuation.yield(frame) }
    }

    /// Ends the frame stream and hands back the whole recording.
    func finish() -> [Float] {
        continuation.finish()
        lock.lock()
        defer { lock.unlock() }
        return samples
    }
}
