import AVFoundation
import Foundation
import Observation
import Speech

/// Hears you for Blob's text mode. Uses Apple's on-device `SpeechAnalyzer`
/// with `SpeechTranscriber` (iOS 26), which mishears far less than the old
/// `SFSpeechRecognizer`, and falls back to the OS app's `Dictation` for a
/// language the new model doesn't cover. Nothing leaves the phone.
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

    private var finalized = ""
    private var engine: AVAudioEngine?
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var results: Task<Void, Never>?
    private var fallback: Dictation?

    func start() async throws {
        text = ""; finalized = ""; level = 0
        guard await AVAudioApplication.requestRecordPermission() else { throw ListenError.microphoneOff }
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)
        else { return await startFallback() }

        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            preparing = true
            defer { preparing = false }
            try await install.downloadAndInstall()
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
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
        try await analyzer.start(inputSequence: stream)
        try startEngine(feeding: continuation, as: format)
    }

    /// Stops listening and returns everything heard, once the model has
    /// finished its last phrase.
    func stop() async -> String {
        if let fallback {
            fallback.stop()
            self.fallback = nil
            return text
        }
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        engine = nil
        input?.finish()
        input = nil
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        await results?.value
        analyzer = nil
        results = nil
        level = 0
        return text
    }

    /// Drops everything without waiting for the model.
    func cancel() {
        fallback?.stop(); fallback = nil
        engine?.stop(); engine?.inputNode.removeTap(onBus: 0); engine = nil
        input?.finish(); input = nil
        results?.cancel(); results = nil
        if let analyzer { Task { await analyzer.cancelAndFinishNow() } }
        analyzer = nil
        level = 0
    }

    private func apply(_ result: SpeechTranscriber.Result) {
        let phrase = String(result.text.characters)
        if result.isFinal {
            finalized += phrase
            text = finalized
        } else {
            text = finalized + phrase
        }
    }

    private func startFallback() async {
        let dictation = Dictation()
        fallback = dictation
        await dictation.start(base: "") { [weak self] heard in self?.text = heard }
    }

    private func startEngine(feeding continuation: AsyncStream<AnalyzerInput>.Continuation, as target: AVAudioFormat?) throws {
        let engine = AVAudioEngine()
        let node = engine.inputNode
        let natural = node.outputFormat(forBus: 0)
        let converter = target.flatMap { $0 == natural ? nil : AVAudioConverter(from: natural, to: $0) }
        node.installTap(onBus: 0, bufferSize: 2048, format: natural) { [weak self] buffer, _ in
            let peak = Self.peak(of: buffer)
            if let converter, let target, let converted = Self.convert(buffer, with: converter, to: target) {
                continuation.yield(AnalyzerInput(buffer: converted))
            } else {
                continuation.yield(AnalyzerInput(buffer: buffer))
            }
            Task { @MainActor in self?.level = min(1, Double(peak) * 4) }
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
    static func activateSession(record: Bool) throws {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        if record {
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .duckOthers])
        } else {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        }
        try session.setActive(true)
        #endif
    }
}
