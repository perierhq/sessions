import AVFoundation
import Foundation

/// "One sec." when the supervisor takes a while: Blob says a short filler
/// once per turn if nothing has been spoken 4 s after your message went out.
///
/// The server voice's fillers are fetched once and kept on the device, in
/// `Caches/BlobFiller/<voiceId>/`, keyed by voice and model from
/// `GET /api/blob/speech/status`. Playing one needs no network, so it is
/// instant. Until the cache is filled (first use, or after the voice or
/// model changes) Blob says it with an Apple voice and fills the cache in
/// the background. Separate from `BlobSpeaker` so a filler never touches
/// the answer's own playback; the view stops it when the answer starts.
@MainActor
final class BlobFiller {
    nonisolated static let phrases = ["One sec.", "Let me check.", "Give me a moment."]
    /// Quiet this long after sending before the filler plays.
    static let delay: Duration = .seconds(4)

    private var player: AVAudioPlayer?
    private let synthesizer = AVSpeechSynthesizer()
    private var filling: Task<Void, Never>?
    private var fillingKey: String?

    /// Says a random filler: from the cache when it holds the current server
    /// voice's, else with an Apple voice while the cache fills.
    func play(speaker: BlobSpeaker) async {
        guard UserDefaults.standard.object(forKey: BlobSpeaker.readAloudKey) as? Bool ?? true else { return }
        let status = await speaker.refreshServerVoice()
        if let key = Self.key(status) {
            if let data = await Self.cached(key) {
                guard !Task.isCancelled else { return }
                try? BlobListener.activateSession(record: false)
                player = try? AVAudioPlayer(data: data)
                player?.play()
                return
            }
            fill(key)
        }
        guard !Task.isCancelled, let phrase = Self.phrases.randomElement(),
              let voice = BlobSpeaker.voice(for: phrase) else { return }
        try? BlobListener.activateSession(record: false)
        let utterance = AVSpeechUtterance(string: phrase)
        utterance.voice = voice
        synthesizer.speak(utterance)
    }

    func stop() {
        player?.stop()
        player = nil
        synthesizer.stopSpeaking(at: .immediate)
    }

    // MARK: Cache

    struct Key: Equatable, Sendable {
        var voiceId: String
        var model: String
    }

    private static func key(_ status: OS1API.BlobSpeechStatus?) -> Key? {
        guard let status, status.configured, let voice = status.voiceId, !voice.isEmpty else { return nil }
        return Key(voiceId: safe(voice), model: safe(status.model ?? "default"))
    }

    /// Fetches the three fillers once for this voice and model, replacing
    /// whatever the voice's folder held for another model.
    private func fill(_ key: Key) {
        let id = "\(key.voiceId)/\(key.model)"
        guard fillingKey != id else { return }
        fillingKey = id
        filling = Task.detached(priority: .utility) {
            var clips: [Data] = []
            for phrase in Self.phrases {
                guard let data = try? await OS1API.blobSpeech(phrase), !data.isEmpty else { break }
                clips.append(data)
            }
            if clips.count == Self.phrases.count { Self.store(clips, key) }
            await MainActor.run { [weak self] in
                if self?.fillingKey == id { self?.fillingKey = nil }
            }
        }
    }

    private nonisolated static func folder(_ key: Key) -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appending(path: "BlobFiller", directoryHint: .isDirectory)
            .appending(path: key.voiceId, directoryHint: .isDirectory)
    }

    private nonisolated static func file(_ key: Key, _ index: Int) -> URL? {
        folder(key)?.appending(path: "\(key.model)-\(index).mp3")
    }

    /// A random cached filler for `key`, or nil when any is missing.
    private nonisolated static func cached(_ key: Key) async -> Data? {
        await Task.detached(priority: .userInitiated) {
            let files = phrases.indices.compactMap { file(key, $0) }
            guard files.count == phrases.count,
                  files.allSatisfy({ FileManager.default.fileExists(atPath: $0.path) }),
                  let pick = files.randomElement()
            else { return nil }
            return try? Data(contentsOf: pick)
        }.value
    }

    private nonisolated static func store(_ clips: [Data], _ key: Key) {
        guard let folder = folder(key) else { return }
        let manager = FileManager.default
        // One model per voice: clear clips for another model first.
        try? manager.removeItem(at: folder)
        try? manager.createDirectory(at: folder, withIntermediateDirectories: true)
        for (index, data) in clips.enumerated() {
            if let url = file(key, index) { try? data.write(to: url, options: .atomic) }
        }
    }

    /// A path component that can't climb out of the cache folder.
    private static func safe(_ raw: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        let cleaned = String(String.UnicodeScalarView(raw.unicodeScalars.map { allowed.contains($0) ? $0 : "_" }))
        return cleaned.isEmpty || cleaned.hasPrefix(".") ? "_" + cleaned : cleaned
    }
}
