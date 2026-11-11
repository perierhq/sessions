import CoreML
import FluidAudio
import Foundation
import Network
import Observation
import os
#if os(iOS)
import UIKit
#endif

/// NVIDIA's Parakeet speech model on this device, through FluidAudio
/// (https://github.com/FluidInference/FluidAudio). Blob's best transcriber:
/// it runs on the Neural Engine, hears Polish as well as English, and nothing
/// leaves the device. `BlobTextTalk` asks it for the final text once you stop
/// talking; Apple's recognizer still draws the live captions.
///
/// The model (Parakeet Ultra, 25 European languages, about 630 MB) is
/// downloaded once, from Settings or on first use over Wi-Fi, into
/// Application Support (FluidAudio's default place), kept out of backups. A
/// download that isn't allowed on cellular pauses when the network turns
/// metered and resumes from where it stopped. The model loads as soon as the
/// app is in front (`appActive`) and when you start talking, and stays
/// loaded in the background, so a quick trip to another app costs nothing.
/// It is let go on a memory warning, also when one comes mid-load. Blob has
/// no background modes, so iOS suspends it soon after it leaves and may end
/// it while it holds the model; the next launch loads the model again, from
/// the system's compiled-model cache below.
///
/// Why a load can take tens of seconds: the files are compiled Core ML
/// models (`.mlmodelc`), so nothing is compiled from source on load, but
/// loading the encoder for the Neural Engine runs Apple's ANE compiler on
/// it. The system keeps the result in the app's caches (on a Mac,
/// `~/Library/Caches/<app>/com.apple.e5rt.e5bundlecache/<OS build>/`), so
/// the first load after the download, an OS update or a purge of the caches
/// pays for it, and later loads, in this launch or the next, are quick (on
/// an M-series Mac the encoder took 36 s cold and 0.1 s from that cache).
/// Keeping the model loaded, and loading it before you talk, keeps the slow
/// load out of a turn.
@MainActor
@Observable
final class BlobParakeet {
    static let shared = BlobParakeet()

    enum State: Equatable {
        case absent
        case downloading(Double)
        /// Stopped when the network turned metered; the next download
        /// continues from the bytes already on disk.
        case paused(Double)
        /// On disk; not loaded.
        case downloaded
        case loading
        case ready
        case failed(String)
    }

    nonisolated static let version: AsrModelVersion = .ultra
    static let sizeLabel = "about 630 MB"
    static let log = Logger(subsystem: "pl.sessions.blob", category: "parakeet")

    private(set) var state: State = .absent
    private var manager: AsrManager?
    private var work: Task<Void, Never>?
    /// Someone wants the model loaded. `unload()` clears it, so a load that
    /// finishes after a memory warning lets the model go again.
    private var wanted = false
    /// Why a running download is being stopped.
    private enum Stop { case user, network }
    private var stopping: Stop?
    private var network: NWPathMonitor?
    /// When the load under way began, and how long the load that left the
    /// model ready took (`takeLoadMs`, for `BlobMetrics`).
    private var loadStartedAt: ContinuousClock.Instant?
    private var readyLoadMs: Int?
    /// Counts loads, so a turn that gave up on one can be told when that
    /// same load finished.
    private(set) var load = 0
    /// The last load whose time a turn has recorded: each load's time goes
    /// on one turn only.
    private var reportedLoad = 0
    /// FluidAudio reports each model file as its own pass from 0 to 1.
    private var pass = 0
    private var passFraction = 0.0

    private init() {
        state = Self.onDisk ? .downloaded : .absent
        #if os(iOS)
        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { _ in MainActor.assumeIsolated { BlobParakeet.shared.unload() } }
        #endif
    }

    nonisolated static var directory: URL { AsrModels.defaultCacheDirectory(for: version) }
    nonisolated static var onDisk: Bool { AsrModels.modelsExist(at: directory, version: version) }

    var isDownloaded: Bool {
        switch state {
        case .downloaded, .loading, .ready: true
        default: false
        }
    }

    var isDownloading: Bool {
        if case .downloading = state { true } else { false }
    }

    /// Downloads the model, or continues a paused download. Without
    /// `overCellular` it pauses as soon as the network is cellular or in Low
    /// Data Mode. After a failure it starts over from nothing.
    func download(overCellular: Bool = false) {
        guard work == nil, !isDownloaded else { return }
        var force = false
        var shown = 0.0
        switch state {
        case .failed: force = true
        case .paused(let fraction): shown = fraction
        default: break
        }
        state = .downloading(shown)
        pass = 0
        passFraction = 0
        stopping = nil
        if !overCellular { watchNetwork() }
        work = Task {
            do {
                try await AsrModels.download(force: force, version: Self.version) { progress in
                    let fraction = progress.fractionCompleted
                    Task { @MainActor in BlobParakeet.shared.progressed(fraction) }
                }
                state = .downloaded
            } catch {
                switch stopping {
                case .user:
                    state = .absent
                    await Self.removeModel()
                case .network:
                    if case .downloading(let fraction) = state { state = .paused(fraction) } else { state = .paused(0) }
                case nil:
                    state = .failed(error.localizedDescription)
                }
            }
            network?.cancel()
            network = nil
            stopping = nil
            work = nil
            if wanted { warm() }
        }
    }

    /// Stops a download and drops what it had fetched.
    func cancelDownload() {
        guard isDownloading, stopping == nil else { return }
        stopping = .user
        work?.cancel()
    }

    /// Removes the downloaded model to free its space. Blob then uses the
    /// fallback until Parakeet is downloaded again.
    func delete() {
        guard work == nil, isDownloaded || state.isFailed else { return }
        wanted = false
        let manager = self.manager
        self.manager = nil
        state = .absent
        work = Task {
            await manager?.cleanup()
            await Self.removeModel()
            work = nil
        }
    }

    /// Downloads on first use when the network costs nothing extra (Wi-Fi or
    /// a wired connection, not cellular or Low Data Mode).
    func downloadIfFree() {
        switch state {
        case .absent, .paused: break
        default: return
        }
        Task {
            if await Self.unmeteredNetwork() { download() }
        }
    }

    /// Loads the downloaded model so the next transcription is quick.
    func warm() {
        wanted = true
        guard state == .downloaded, work == nil else { return }
        state = .loading
        loadStartedAt = .now
        load += 1
        let load = load
        work = Task {
            do {
                let models = try await AsrModels.load(from: Self.directory, version: Self.version)
                let manager = AsrManager(config: .default)
                try await manager.loadModels(models)
                let ms = loadStartedAt.map { BlobMetrics.elapsedMs(since: $0) }
                Self.log.info("load done ms=\(ms ?? -1, privacy: .public) load=\(load, privacy: .public) kept=\(self.wanted, privacy: .public)")
                if wanted {
                    self.manager = manager
                    readyLoadMs = ms
                    state = .ready
                    if let ms, BlobMetrics.shared.parakeetLoaded(ms: ms, load: load) { reportedLoad = load }
                } else {
                    // Unloaded while it loaded: a memory warning.
                    // Its time is no load time; no turn records it.
                    await manager.cleanup()
                    state = .downloaded
                }
            } catch {
                // A broken download: offer the download again.
                state = Self.onDisk ? .failed(error.localizedDescription) : .absent
            }
            loadStartedAt = nil
            work = nil
            // Wanted again while the model was being let go.
            if wanted, state == .downloaded { warm() }
        }
    }

    /// The app is in front, at launch or back from the background: loads
    /// the model when Parakeet is picked and downloaded. In the background
    /// the model stays loaded.
    func appActive() {
        if BlobTranscriber.current == .parakeet { warm() }
    }

    func unload() {
        wanted = false
        guard state == .ready, let manager else { return }
        self.manager = nil
        state = .downloaded
        Task { await manager.cleanup() }
    }

    /// How long the load that left the model ready took, for the first turn
    /// that uses it or waited for it; nil after that, or when not ready.
    /// With `load`, only when that is the load that left it ready.
    func takeLoadMs(of load: Int? = nil) -> Int? {
        guard state == .ready, load == nil || load == self.load, reportedLoad != self.load else { return nil }
        reportedLoad = self.load
        return readyLoadMs
    }

    /// True once the model is loaded, waiting up to `seconds` for a load
    /// already under way, for as long as `waiting` holds.
    func ready(within seconds: Double, while waiting: () -> Bool = { true }) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while state == .loading, ContinuousClock.now < deadline, !Task.isCancelled, waiting() {
            try? await Task.sleep(for: .milliseconds(100))
        }
        return state == .ready
    }

    /// Transcribes 16 kHz mono samples. Throws when the model isn't loaded.
    func transcribe(_ samples: [Float], language: String?) async throws -> String {
        guard state == .ready, let manager else { throw TranscribeError.notReady }
        var decoder = TdtDecoderState.make()
        let result = try await manager.transcribe(
            samples, decoderState: &decoder, language: language.flatMap(Language.init(rawValue:))
        )
        return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    enum TranscribeError: Error { case notReady }

    /// Share of the whole download each FluidAudio pass covers, in the order
    /// it fetches them: preprocessor, encoder, decoder, joint. The encoder is
    /// almost all of it.
    private static let passShares = [0.01, 0.96, 0.015, 0.015]

    /// One progress report from FluidAudio. Each pass starts again at 0, so
    /// a drop means the next file; the bar never moves back.
    private func progressed(_ fraction: Double) {
        guard case .downloading(let shown) = state, stopping == nil else { return }
        if fraction + 0.5 < passFraction { pass += 1 }
        passFraction = fraction
        let done = Self.passShares.prefix(pass).reduce(0, +)
        let share = pass < Self.passShares.count ? Self.passShares[pass] : 0
        state = .downloading(max(shown, min(0.99, done + share * fraction)))
    }

    /// Pauses the download once the network turns metered. The first update
    /// reports the current path, so a download started on cellular pauses
    /// straight away.
    private func watchNetwork() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { path in
            guard path.isExpensive || path.isConstrained else { return }
            Task { @MainActor in BlobParakeet.shared.pauseForNetwork() }
        }
        monitor.start(queue: DispatchQueue(label: "blob.parakeet.network"))
        network = monitor
    }

    private func pauseForNetwork() {
        guard isDownloading, stopping == nil else { return }
        stopping = .network
        work?.cancel()
    }

    nonisolated private static func removeModel() async {
        let directory = directory
        await Task.detached { try? FileManager.default.removeItem(at: directory) }.value
    }

    /// The models are a download, not your data: keeps
    /// `…/Application Support/FluidAudio` (Parakeet and the VAD model) out of
    /// backups. Called at launch, before anything downloads into it.
    nonisolated static func excludeFromBackup() {
        var root = MLModelConfigurationUtils.defaultModelsDirectory().deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? root.setResourceValues(values)
    }

    /// Wi-Fi or wired: not cellular, not Low Data Mode.
    static func unmeteredNetwork() async -> Bool {
        await withCheckedContinuation { continuation in
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { path in
                monitor.cancel()
                continuation.resume(returning: path.status == .satisfied && !path.isExpensive && !path.isConstrained)
            }
            monitor.start(queue: DispatchQueue(label: "blob.network"))
        }
    }
}

extension BlobParakeet.State {
    var isFailed: Bool {
        if case .failed = self { true } else { false }
    }
}

/// FluidAudio's Silero voice activity model, for `BlobEndpointer`. A small
/// download (about 1 MB) the first time; until it is loaded the listener
/// goes by the input level instead.
actor BlobVoiceActivity {
    static let shared = BlobVoiceActivity()
    /// Samples per VAD frame: 256 ms at 16 kHz, the model's own window.
    static let frame = VadManager.chunkSize

    private var manager: VadManager?
    private var loading: Task<VadManager?, Never>?

    var isLoaded: Bool { manager != nil }

    func load() async -> VadManager? {
        if let manager { return manager }
        if let loading { return await loading.value }
        let task = Task { try? await VadManager() }
        loading = task
        manager = await task.value
        loading = nil
        return manager
    }

    func makeStreamState() async -> VadStreamState? {
        await manager?.makeStreamState()
    }

    /// Probability that `chunk` is speech, with the stream's next state.
    func probability(_ chunk: [Float], state: VadStreamState) async -> (Float, VadStreamState)? {
        guard let manager,
              let result = try? await manager.processStreamingChunk(chunk, state: state)
        else { return nil }
        return (result.probability, result.state)
    }
}
