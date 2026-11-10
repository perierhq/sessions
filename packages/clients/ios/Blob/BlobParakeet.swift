import CoreML
import FluidAudio
import Foundation
import Network
import Observation
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
/// Application Support (FluidAudio's default place), kept out of backups. It
/// loads when Blob needs it and stays loaded while the app is in front; it is
/// unloaded in the background and on a memory warning.
@MainActor
@Observable
final class BlobParakeet {
    static let shared = BlobParakeet()

    enum State: Equatable {
        case absent
        case downloading(Double)
        /// On disk; not loaded.
        case downloaded
        case loading
        case ready
        case failed(String)
    }

    static let version: AsrModelVersion = .ultra
    /// What the model directory holds once downloaded, for the progress bar.
    static let downloadBytes: Int64 = 632_000_000
    static let sizeLabel = "about 630 MB"

    private(set) var state: State = .absent
    private var manager: AsrManager?
    private var work: Task<Void, Never>?

    private init() {
        state = Self.onDisk ? .downloaded : .absent
        #if os(iOS)
        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { _ in MainActor.assumeIsolated { BlobParakeet.shared.unload() } }
        #endif
    }

    static var directory: URL { AsrModels.defaultCacheDirectory(for: version) }
    static var onDisk: Bool { AsrModels.modelsExist(at: directory, version: version) }

    var isDownloaded: Bool {
        switch state {
        case .downloaded, .loading, .ready: true
        default: false
        }
    }

    /// Downloads the model. Safe to call again; a running download continues.
    func download() {
        guard work == nil, !isDownloaded else { return }
        state = .downloading(0)
        work = Task {
            let watcher = Task { await self.watchProgress() }
            defer { watcher.cancel() }
            do {
                try await AsrModels.download(version: Self.version)
                Self.excludeFromBackup()
                state = .downloaded
            } catch {
                state = .failed(error.localizedDescription)
            }
            work = nil
        }
    }

    /// Downloads on first use when the network costs nothing extra (Wi-Fi or
    /// a wired connection, not cellular or Low Data Mode).
    func downloadIfFree() {
        guard state == .absent else { return }
        Task {
            if await Self.unmeteredNetwork() { download() }
        }
    }

    /// Loads the downloaded model so the next transcription is quick.
    func warm() {
        guard state == .downloaded, work == nil else { return }
        state = .loading
        work = Task {
            do {
                let models = try await AsrModels.load(from: Self.directory, version: Self.version)
                let manager = AsrManager(config: .default)
                try await manager.loadModels(models)
                self.manager = manager
                state = .ready
            } catch {
                // A broken download: offer the download again.
                state = Self.onDisk ? .failed(error.localizedDescription) : .absent
            }
            work = nil
        }
    }

    func unload() {
        guard state == .ready, let manager else { return }
        self.manager = nil
        state = .downloaded
        Task { await manager.cleanup() }
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

    /// Progress from the bytes on disk: FluidAudio reports each file on its
    /// own, and the encoder is almost all of it.
    private func watchProgress() async {
        let directory = Self.directory
        while !Task.isCancelled {
            let bytes = await Task.detached { Self.size(of: directory) }.value
            if case .downloading = state {
                state = .downloading(min(0.99, Double(bytes) / Double(Self.downloadBytes)))
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    nonisolated private static func size(of directory: URL) -> Int64 {
        guard let files = FileManager.default.enumerator(
            at: directory, includingPropertiesForKeys: [.fileSizeKey]
        ) else { return 0 }
        var total: Int64 = 0
        for case let file as URL in files {
            total += Int64((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return total
    }

    /// The models are a download, not your data: keep them out of backups.
    private static func excludeFromBackup() {
        // `…/Application Support/FluidAudio`, which holds the VAD model too.
        var root = directory.deletingLastPathComponent().deletingLastPathComponent()
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? root.setResourceValues(values)
    }

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
